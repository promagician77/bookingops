// results/*.json -> site/data/site.json (only what the page draws) + fonts into site/fonts
import fs from "node:fs";
import { makeWorkload } from "../src/workload.js";

const chaos = JSON.parse(fs.readFileSync("results/chaos.json")), mcp = JSON.parse(fs.readFileSync("results/mcp.json")), wh = JSON.parse(fs.readFileSync("results/webhooks.json"));
const keys = ["bookings", "seatsBooked", "revenue", "oversoldSeats", "oversoldSlots", "chargedTwice", "chargedNoBooking", "holdNoBooking", "refundDue", "lostWithSeatsLeft", "errorsSeen", "inProgressSeen", "stuckHeld", "counterMismatch", "waitedCustomers", "waitedThenBooked", "crashes", "p50", "p95"];
const summary = {};
for (const [k, v] of Object.entries(chaos.summary)) { summary[k] = { paths: v.paths, gateway: v.gateway }; for (const m of keys) summary[k][m] = { sum: v[m].sum, per: v[m].per, min: v[m].min, max: v[m].max }; }

// race replay: the departure where the old pattern oversold most, among those with a readable number of customers
const N = chaos.meta.intentsPerRun, { slots, intents } = makeWorkload(1, N), byId = Object.fromEntries(intents.map((i) => [i.id, i]));
const runOf = (flow) => chaos.runs.find((r) => r.scenario === "clean" && r.flow === flow && r.seed === 1);
function lanes(flow, slotId) {
  const per = {}; for (const e of runOf(flow).events) if (byId[e.id].slotId === slotId) (per[e.id] ||= []).push(e);
  return Object.entries(per).map(([id, ev]) => ({ id, seats: byId[id].seats, ev: ev.map((e) => ({ t: e.t, e: e.ev, ...(e.taken != null ? { taken: e.taken } : {}), ...(e.ok != null ? { ok: e.ok } : {}), ...(e.respstat ? { r: e.respstat } : {}), ...(e.reason ? { reason: e.reason } : {}) })) }))
    .sort((a, b) => a.ev[0].t - b.ev[0].t);
}
let best = null;
for (const sl of slots) {
  const L = lanes("legacy", sl._id); if (L.length < 6 || L.length > 20) continue;
  const seats = L.filter((l) => l.ev.some((e) => e.e === "confirmed")).reduce((s, l) => s + l.seats, 0);
  const over = seats - sl.capacity;
  if (over > 0 && (!best || over > best.over || (over === best.over && L.length < best.n))) best = { slot: sl, over, n: L.length };
}
const race = best && { slot: best.slot, oversold: best.over, legacy: lanes("legacy", best.slot._id), robust: lanes("robust", best.slot._id) };

const out = {
  chaos: { meta: chaos.meta, summary },
  race,
  mcp: { sdk: mcp.sdk, data: mcp.data, parityBefore: { ...mcp.parityBefore }, parityAfter: { calls: mcp.parityAfter.calls, identical: mcp.parityAfter.identical }, moveParity: mcp.moveParity,
    tools: mcp.gates.tools, checks: mcp.gates.checks, audit: mcp.gates.auditSample.slice(0, 5), auditEntries: mcp.gates.auditEntries, overhead: mcp.overhead },
  webhooks: wh,
  tests: fs.existsSync("results/tests.json") ? JSON.parse(fs.readFileSync("results/tests.json")) : [],
};
fs.mkdirSync("site/data", { recursive: true });
fs.writeFileSync("site/data/site.json", JSON.stringify(out));
fs.mkdirSync("site/fonts", { recursive: true });
for (const [pkg, f] of [["instrument-sans", "instrument-sans-latin-400-normal.woff2"], ["instrument-sans", "instrument-sans-latin-600-normal.woff2"], ["instrument-sans", "instrument-sans-latin-700-normal.woff2"], ["spline-sans-mono", "spline-sans-mono-latin-400-normal.woff2"], ["spline-sans-mono", "spline-sans-mono-latin-500-normal.woff2"]])
  fs.copyFileSync(`node_modules/@fontsource/${pkg}/files/${f}`, `site/fonts/${f}`);
console.log("site/data/site.json", (fs.statSync("site/data/site.json").size / 1024).toFixed(1), "KB; race slot", race?.slot._id, "cap", race?.slot.capacity, "oversold", race?.oversold, "lanes", race?.legacy.length);
