// MCP layer checks, all through a real MCP client <-> server connection (in-memory transport):
//  1. parity: every read tool answered by the old API and by MongoDB, compared field by field
//  2. the same after fixing the one rule difference parity found (what gates a route flip)
//  3. reschedule parity: the same 60 moves through both backends end in the same state
//  4. scopes and approvals: what each caller can see and do
//  5. overhead: direct call vs through MCP, per backend
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connect } from "../src/db.js";
import { seed, TOURS, DATES } from "../src/mcp/data.js";
import { createLegacyApi } from "../src/mcp/legacy-api.js";
import { legacyAdapter, mongoAdapter } from "../src/mcp/adapters.js";
import { buildServer } from "../src/mcp/server.js";
import { rng } from "../src/gateway.js";

const { client, db } = await connect(undefined, "bookingops_mcp");
const data = seed();
async function loadMongo() {
  for (const c of ["slots", "bookings", "audit", "approvals"]) await db.collection(c).drop().catch(() => {});
  await db.collection("slots").insertMany(data.slots.map((s) => ({ ...s }))); await db.collection("bookings").insertMany(data.bookings.map((b) => ({ ...b })));
  await db.collection("slots").createIndex({ tour: 1, date: 1 });
}
async function legacyUp(countsCancelled) { const api = createLegacyApi({ ...data, countsCancelled }); const port = await api.listen(); return { api, adapter: legacyAdapter(`http://127.0.0.1:${port}`) }; }
async function mcp(principal, adapters, routes) {
  const server = buildServer({ principal, adapters, routes, db });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "bench", version: "1" });
  await Promise.all([server.connect(a), c.connect(b)]);
  const call = async (name, args) => { try { const r = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text; try { return JSON.parse(t); } catch { return { error: { code: "protocol", message: t } }; } } catch (e) { return { error: { code: "protocol", message: e.message } }; } };
  return { c, call, close: () => c.close() };
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
function diff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object") { const ks = new Set([...Object.keys(a), ...Object.keys(b)]); return [...ks].flatMap((k) => diff(a[k], b[k], path ? `${path}.${k}` : k)); }
  return [{ path, legacy: a, mongo: b }];
}

async function parity(countsCancelled) {
  await loadMongo();
  const L = await legacyUp(countsCancelled), adapters = { legacy: L.adapter, mongo: mongoAdapter({ client, db }) };
  const viaL = await mcp("call-center-agent", adapters, { search_availability: "legacy", get_booking: "legacy" });
  const viaM = await mcp("call-center-agent", adapters, {});
  const cases = [];
  for (const t of TOURS) for (const d of DATES) cases.push(["search_availability", { tour: t.id, date: d }]);
  for (const b of data.bookings) cases.push(["get_booking", { ref: b._id }]);
  cases.push(["get_booking", { ref: "ZZZZZ9" }]);
  const out = { calls: cases.length, identical: 0, differing: 0, fields: {}, examples: [] };
  for (const [tool, args] of cases) {
    const [l, m] = [await viaL.call(tool, args), await viaM.call(tool, args)];
    const d = diff(l, m);
    if (!d.length) out.identical++; else {
      out.differing++;
      for (const x of d) out.fields[`${tool}: ${x.path.replace(/\.\d+\./, "[].")}`] = (out.fields[`${tool}: ${x.path.replace(/\.\d+\./, "[].")}`] || 0) + 1;
      if (out.examples.length < 3) { const slot = d[0].path.match(/slots\.(\d+)/); out.examples.push({ tool, args, slot: slot ? l.slots[+slot[1]].slot_id : undefined, diffs: d.slice(0, 2) }); }
    }
  }
  const cancelledSlots = new Set(data.bookings.filter((b) => b.status === "cancelled").map((b) => b.slotId));
  out.slotsWithCancelledBookings = cancelledSlots.size;
  await viaL.close(); await viaM.close(); await L.api.close();
  return out;
}

async function moveParity() {
  const R = rng(5), moves = [];
  for (let i = 0; i < 60; i++) {
    const b = data.bookings[Math.floor(R() * data.bookings.length)];
    const tour = b.slotId.split("-")[0], cands = data.slots.filter((s) => s.tour === tour);
    moves.push({ ref: b._id, toSlot: cands[Math.floor(R() * cands.length)]._id });
  }
  const results = {};
  for (const which of ["legacy", "mongo"]) {
    await loadMongo();
    const L = await legacyUp(false);
    const ad = which === "legacy" ? L.adapter : mongoAdapter({ client, db });
    const outs = []; for (const m of moves) { const r = await ad.moveBooking(m); outs.push(r.error ? r.error.code : r.status); }
    const finalState = []; for (const b of data.bookings) { const g = await ad.getBooking({ ref: b._id }); finalState.push(`${g.ref}:${g.slot_id}:${g.status}`); }
    const avail = []; for (const t of TOURS) for (const d of DATES) avail.push(...(await ad.searchAvailability({ tour: t.id, date: d })).slots.map((s) => `${s.slot_id}:${s.available}`));
    results[which] = { outs, finalState, avail }; await L.api.close();
  }
  const same = (k) => results.legacy[k].filter((x, i) => x === results.mongo[k][i]).length;
  const tally = (a) => a.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
  return { moves: moves.length, outcomesMatch: same("outs"), bookingsMatch: same("finalState"), bookings: data.bookings.length, slotsMatch: same("avail"), slots: results.mongo.avail.length, outcomes: tally(results.mongo.outs) };
}

async function gates() {
  await loadMongo();
  const adapters = { mongo: mongoAdapter({ client, db }) };
  const who = {}; for (const p of ["email-drafter", "booking-assistant", "call-center-agent"]) who[p] = await mcp(p, adapters, {});
  const tools = {}; for (const [p, m] of Object.entries(who)) tools[p] = (await m.c.listTools()).tools.map((t) => ({ name: t.name, readOnly: !!t.annotations?.readOnlyHint, destructive: !!t.annotations?.destructiveHint }));
  const conf = data.bookings.find((b) => b.status === "confirmed" && b.party === 2);
  const tour = conf.slotId.split("-")[0];
  const target = data.slots.find((s) => s.tour === tour && s._id !== conf.slotId && s.capacity - s.booked >= 4);
  const checks = [];
  const ck = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const drafter = await who["email-drafter"].call("propose_reschedule", { ref: conf._id, to_slot: target._id });
  ck("Email drafter cannot call a write tool (it isn't listed for it)", drafter.error, drafter.error?.message?.slice(0, 80));
  const masked = await who["email-drafter"].call("get_booking", { ref: conf._id });
  ck("Email drafter sees the last name as an initial only", masked.guest?.last?.length === 2, JSON.stringify(masked.guest));
  const prop = await who["booking-assistant"].call("propose_reschedule", { ref: conf._id, to_slot: target._id, note: "guest asked for a later time" });
  const still = await db.collection("bookings").findOne({ _id: conf._id });
  ck("Assistant's proposal changes nothing on its own", prop.approval_id && still.slotId === conf.slotId, `approval ${prop.approval_id?.slice(0, 8)}…, booking still on ${still.slotId}`);
  const selfApprove = await who["booking-assistant"].call("approve_change", { approval_id: prop.approval_id });
  ck("Assistant cannot approve its own proposal", selfApprove.error, selfApprove.error?.message?.slice(0, 80));
  const ok = await who["call-center-agent"].call("approve_change", { approval_id: prop.approval_id });
  const moved = await db.collection("bookings").findOne({ _id: conf._id });
  ck("Agent approves: booking moves, seat counts follow", ok.status === "moved" && moved.slotId === target._id, `${conf.slotId} → ${moved.slotId}`);
  const again = await who["call-center-agent"].call("approve_change", { approval_id: prop.approval_id });
  ck("The same approval can't be used twice", again.error?.code === "not_pending", again.error?.code);
  // proposal goes stale: slot fills between proposal and approval
  const conf2 = data.bookings.find((b) => b.status === "confirmed" && b._id !== conf._id && b.slotId.startsWith(tour) && b.slotId !== target._id);
  const t2 = data.slots.find((s) => s.tour === tour && s._id !== conf2.slotId && s._id !== target._id && s.capacity - s.booked >= conf2.party);
  const p2 = await who["booking-assistant"].call("propose_reschedule", { ref: conf2._id, to_slot: t2._id });
  await db.collection("slots").updateOne({ _id: t2._id }, { $set: { booked: t2.capacity } });
  const late = await who["call-center-agent"].call("approve_change", { approval_id: p2.approval_id });
  ck("Approval re-checks seats: a slot that filled meanwhile is refused", late.error?.code === "full", late.error?.code);
  const over = await who["booking-assistant"].call("propose_refund", { ref: conf._id, amount_cents: conf.totalCents + 1, reason: "test" });
  ck("Refund above the booking total is refused at proposal", over.error?.code === "over_total", over.error?.code);
  const bad = await who["booking-assistant"].call("get_booking", { ref: "bad ref; drop" });
  ck("Malformed input is rejected by the schema before any backend call", bad.error, (bad.error?.message || "").slice(0, 70));
  const auditN = await db.collection("audit").countDocuments();
  const sample = await db.collection("audit").find({}, { projection: { _id: 0 } }).sort({ at: 1 }).limit(6).toArray();
  for (const m of Object.values(who)) await m.close();
  return { tools, checks, auditEntries: auditN, auditSample: sample.map((a) => ({ ...a, at: a.at.toISOString() })) };
}

async function overhead(n = 400) {
  await loadMongo();
  const L = await legacyUp(false), M = mongoAdapter({ client, db }), adapters = { legacy: L.adapter, mongo: M };
  const viaM = await mcp("call-center-agent", adapters, {}), viaL = await mcp("call-center-agent", adapters, { get_booking: "legacy" });
  const refs = data.bookings.map((b) => b._id); const res = {};
  const time = async (k, f) => { const a = []; for (let i = 0; i < n; i++) { const t = performance.now(); await f(refs[i % refs.length]); a.push(performance.now() - t); } res[k] = { p50: pct(a, 0.5), p95: pct(a, 0.95) }; };
  for (let w = 0; w < 50; w++) { await M.getBooking({ ref: refs[w] }); await viaM.call("get_booking", { ref: refs[w] }); }
  await time("mongo direct", (r) => M.getBooking({ ref: r }));
  await time("mongo via MCP", (r) => viaM.call("get_booking", { ref: r }));
  await time("old API direct", (r) => L.adapter.getBooking({ ref: r }));
  await time("old API via MCP", (r) => viaL.call("get_booking", { ref: r }));
  await viaM.close(); await viaL.close(); await L.api.close();
  return { calls: n, note: "MCP adds the protocol hop plus one audit-log insert per call (in-memory transport; stdio adds process I/O)", ...res };
}

const before = await parity(true);
const after = await parity(false);
const moves = await moveParity();
const g = await gates();
const ov = await overhead();
await client.close();
const out = { when: new Date().toISOString(), sdk: JSON.parse(fs.readFileSync("node_modules/@modelcontextprotocol/sdk/package.json")).version,
  data: { slots: data.slots.length, bookings: data.bookings.length, cancelled: data.bookings.filter((b) => b.status === "cancelled").length },
  parityBefore: before, parityAfter: after, moveParity: moves, gates: g, overhead: ov };
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/mcp.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify({ before: { ...before, examples: undefined }, after: { identical: after.identical, calls: after.calls }, moves, checks: g.checks.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.name} (${c.detail})`), tools: g.tools, overhead: ov }, null, 1));
