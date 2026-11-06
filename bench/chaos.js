// Chaos bench: the same booking rush run through both checkout flows on real MongoDB (replica
// set, so transactions work) against the CardPointe-shaped test gateway with injected faults.
// Counts what a customer or the accounting team would notice: oversold seats, customers charged
// twice, charges with no booking, bookings lost to errors while seats were still left.
//   node bench/chaos.js [--seeds 5] [--intents 220] [--out results/chaos.json]
import fs from "node:fs";
import { connect, reset, crasher, CrashError } from "../src/db.js";
import { createGateway, rng } from "../src/gateway.js";
import { cardpointe } from "../src/cardpointe.js";
import { legacyCheckout } from "../src/legacy.js";
import { makeRobust, LostLease } from "../src/robust.js";
import { makeWorkload } from "../src/workload.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEEDS = +arg("seeds", 5), N = +arg("intents", 220), OUT = arg("out", "results/chaos.json");
const SCENARIOS = {
  clean: { label: "No faults: just a busy morning", faults: {}, crashP: 0 },
  faults: { label: "Realistic faults", faults: { dropAfter: 0.03, dropBefore: 0.01, timedOut: 0.01, http500: 0.01, followupDrop: 0.01 }, crashP: 0.01 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function runFlow({ flow, scen, seed, client, db }) {
  const { slots, intents } = makeWorkload(seed, N);
  await reset(db, slots);
  await db.collection("attempts").createIndex({ state: 1, captured: 1 });
  const gwSrv = createGateway({ seed: seed * 31 + (flow === "legacy" ? 1 : 2), faults: scen.faults });
  const port = await gwSrv.listen();
  const gw = cardpointe({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1200 });
  const crash = crasher(rng(seed * 101 + 7), scen.crashP);
  const events = [], t0 = Date.now();
  const trace = (id, ev, d) => events.push({ id, ev, t: Date.now() - t0, ...d });
  const stats = {};
  const robust = makeRobust({ client, db, gw, crash, stats, trace });
  const customer = {}, waited = {}; const lat = [];

  async function serve(intent) {
    await sleep(Math.max(0, intent.arrive - (Date.now() - t0)));
    const start = Date.now(); let last = "error", key = `${intent.id}-k1`, k = 1;
    for (let attempt = 1, waits = 0; attempt <= 3; attempt++) {
      let r;
      try { r = flow === "legacy" ? await legacyCheckout({ db, gw, crash, trace }, intent) : await robust.checkout(intent, key); }
      catch (e) { if (!(e instanceof CrashError || e instanceof LostLease)) throw e; r = { status: "error" }; trace(intent.id, "crash", { stage: e.stage }); }
      last = r.status;
      if (["confirmed", "declined", "sold_out"].includes(last)) break;
      if (flow === "robust" && last === "payment_unavailable") key = `${intent.id}-k${++k}`;   // customer presses Pay again
      if (last === "held_by_others") {        // "2 seats are on hold for another guest, checking again..."
        if (waits++ >= 4) break;
        waited[intent.id] = waits; attempt--; key = `${intent.id}-k${++k}`; await sleep(1000); continue;
      }
      await sleep(500);
    }
    customer[intent.id] = last;
    if (last === "confirmed") lat.push(Date.now() - start);
  }
  // the reconciler runs every second in the background, as it would in production
  let recBusy = false, recTicks = 0;
  const recTimer = flow === "robust" ? setInterval(async () => { if (recBusy) return; recBusy = true; recTicks++; try { await robust.reconcile(); } catch {} recBusy = false; }, 1000) : null;
  // open arrivals: each customer starts at its own time; nobody queues behind a busy worker
  await Promise.all(intents.map(serve));
  const wallMs = Date.now() - t0;
  if (recTimer) { clearInterval(recTimer); while (recBusy) await sleep(20); }
  let rec = null;
  if (flow === "robust") { await robust.drain(); await sleep(3100); rec = await robust.reconcile(); await robust.drain(); rec.second = await robust.reconcile(); await robust.drain(); }

  // ---- what happened, from the database and the gateway's own ledger
  const bookings = await db.collection("bookings").find().toArray();
  const slotDocs = await db.collection("slots").find().toArray();
  const ledger = gwSrv.ledger(), gstats = gwSrv.stats();
  await gwSrv.close();
  const bookedBySlot = {}; for (const b of bookings) bookedBySlot[b.slotId] = (bookedBySlot[b.slotId] || 0) + b.seats;
  const oversoldSeats = slotDocs.reduce((s, sl) => s + Math.max(0, (bookedBySlot[sl._id] || 0) - sl.capacity), 0);
  const oversoldSlots = slotDocs.filter((sl) => (bookedBySlot[sl._id] || 0) > sl.capacity).length;
  const bookedIntents = new Map(); for (const b of bookings) bookedIntents.set(b.intentId, (bookedIntents.get(b.intentId) || 0) + 1);
  const live = ledger.filter((t) => t.respstat === "A" && !t.voided);
  const liveBy = {}; for (const t of live) { const id = t.orderid.split("~")[0]; (liveBy[id] ||= []).push(t); }
  const intentById = Object.fromEntries(intents.map((i) => [i.id, i]));
  let chargedTwice = 0, chargedNoBooking = 0, refundDue = 0, holdNoBooking = 0, captured = 0;
  for (const [id, ts] of Object.entries(liveBy)) {
    const cap = ts.filter((t) => t.captured);
    captured += cap.length;
    if (ts.length >= 2) chargedTwice++;
    const has = bookedIntents.get(id) || 0;
    if (!has) { if (cap.length) { chargedNoBooking++; refundDue += cap.reduce((s, t) => s + +t.amount, 0); } else holdNoBooking++; }
    else if (cap.length > has) refundDue += cap.slice(has).reduce((s, t) => s + +t.amount, 0);
  }
  // failed bookings: good card, no booking, and the slot still had room for the party at the end
  const lostDetail = []; let lostWithSeatsLeft = 0, lostRevenue = 0, errorsSeen = 0, inProgressSeen = 0;
  for (const i of intents) {
    const c = customer[i.id];
    if (c === "error" || c === "payment_unavailable") errorsSeen++;
    if (c === "in_progress") inProgressSeen++;
    if (bookedIntents.has(i.id) || i.card.endsWith("0002")) continue;
    const sl = slotDocs.find((s) => s._id === i.slotId);
    if ((bookedBySlot[i.slotId] || 0) + i.seats <= sl.capacity) { lostWithSeatsLeft++; lostRevenue += i.amount;
      if (lostDetail.length < 12) lostDetail.push({ id: i.id, customer: c, attempts: flow === "robust" ? (await db.collection("attempts").find({ intentId: i.id }).toArray()).map((a) => ({ k: a._id, state: a.state, reason: a.reason, seq: a.authSeq })) : undefined,
        auths: ledger.filter((t) => t.orderid.startsWith(i.id + "~")).map((t) => `${t.respstat}${t.voided ? "v" : ""}${t.captured ? "c" : ""}`), ev: events.filter((e) => e.id === i.id).map((e) => `${e.t}:${e.ev}${e.respstat ? "=" + e.respstat : ""}${e.result ? "=" + e.result : ""}${e.reason ? "=" + e.reason : ""}${e.stage ? "@" + e.stage : ""}`) }); }
  }
  const stuckHeld = slotDocs.reduce((s, sl) => s + (sl.held || 0), 0);
  const waitedCustomers = Object.keys(waited).length, waitedThenBooked = Object.keys(waited).filter((id) => bookedIntents.has(id)).length;
  const counterMismatch = flow === "robust" ? slotDocs.filter((sl) => sl.booked !== (bookedBySlot[sl._id] || 0)).length : 0;
  const unfinished = flow === "robust" ? await db.collection("attempts").countDocuments({ state: { $nin: ["confirmed", "failed"] } }) : 0;
  const uncaptured = flow === "robust" ? await db.collection("attempts").countDocuments({ state: "confirmed", captured: false }) : 0;
  const dupBookings = [...bookedIntents.values()].filter((n) => n > 1).length;
  return {
    flow, scenario: scen.key, seed, intents: N, wallMs,
    bookings: bookings.length, seatsBooked: bookings.reduce((s, b) => s + b.seats, 0), revenue: bookings.reduce((s, b) => s + b.amount, 0),
    oversoldSeats, oversoldSlots, chargedTwice, chargedNoBooking, holdNoBooking, refundDue, dupBookings,
    lostWithSeatsLeft, lostDetail, lostRevenue, errorsSeen, inProgressSeen, stuckHeld, counterMismatch, waitedCustomers, waitedThenBooked, recTicks, unfinished, uncaptured,
    crashes: crash.log.length, crashStages: crash.log.reduce((m, s) => ((m[s] = (m[s] || 0) + 1), m), {}),
    gateway: gstats, paths: stats, reconciler: rec,
    p50: pct(lat, 0.5), p95: pct(lat, 0.95), events: seed === 1 && scen.key === "clean" ? events : undefined,
  };
}

const { client, db } = await connect();
// warm-up (JIT, connection pool, sessions), not recorded
for (const flow of ["legacy", "robust"]) await runFlow({ flow, scen: { ...SCENARIOS.clean, key: "warmup" }, seed: 99, client, db });
const runs = [];
for (const [key, s] of Object.entries(SCENARIOS)) {
  const scen = { ...s, key };
  for (let seed = 1; seed <= SEEDS; seed++) for (const flow of ["legacy", "robust"]) {
    const r = await runFlow({ flow, scen, seed, client, db });
    runs.push(r);
    console.log(`${key.padEnd(6)} seed ${seed} ${flow.padEnd(6)} booked ${String(r.bookings).padStart(3)}  oversold ${String(r.oversoldSeats).padStart(2)}  twice ${r.chargedTwice}  charged-no-booking ${r.chargedNoBooking}  hold-no-booking ${r.holdNoBooking}  lost ${r.lostWithSeatsLeft}  stuck ${r.stuckHeld}/${r.unfinished}/${r.uncaptured}  crashes ${r.crashes}  p95 ${r.p95}ms`);
  }
}
await client.close();
const keys = ["bookings", "seatsBooked", "revenue", "oversoldSeats", "oversoldSlots", "chargedTwice", "chargedNoBooking", "holdNoBooking", "refundDue", "dupBookings", "lostWithSeatsLeft", "lostRevenue", "errorsSeen", "inProgressSeen", "stuckHeld", "counterMismatch", "waitedCustomers", "waitedThenBooked", "unfinished", "uncaptured", "crashes", "p50", "p95"];
const summary = {};
for (const sk of Object.keys(SCENARIOS)) for (const flow of ["legacy", "robust"]) {
  const rs = runs.filter((r) => r.scenario === sk && r.flow === flow); const o = {};
  for (const k of keys) { const v = rs.map((r) => r[k]); o[k] = { sum: v.reduce((a, b) => a + b, 0), mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), min: Math.min(...v), max: Math.max(...v), per: v }; }
  const paths = {}; for (const r of rs) for (const [k, v] of Object.entries(r.paths || {})) paths[k] = (paths[k] || 0) + v;
  const gw = {}; for (const r of rs) for (const [k, v] of Object.entries(r.gateway)) gw[k] = (gw[k] || 0) + v;
  summary[`${sk}/${flow}`] = { ...o, paths, gateway: gw };
}
const meta = { when: new Date().toISOString(), mongo: (await (async () => { const c = await connect(); const v = (await c.db.admin().command({ buildInfo: 1 })).version; await c.client.close(); return v; })()),
  node: process.version, seeds: SEEDS, intentsPerRun: N, arrivalWindowMs: 1500, slots: 40, gatewayClientTimeoutMs: 1200, scenarios: SCENARIOS };
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ meta, summary, runs }, null, 1));
console.log("wrote", OUT);
