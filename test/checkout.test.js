// Each test forces one failure from CardPointe's timed-out-transactions guide (or a dead worker)
// and checks the money and the seats afterwards. Real MongoDB replica set; test gateway.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, reset, CrashError } from "../src/db.js";
import { createGateway } from "../src/gateway.js";
import { cardpointe } from "../src/cardpointe.js";
import { legacyCheckout } from "../src/legacy.js";
import { makeRobust } from "../src/robust.js";

let client, db;
before(async () => ({ client, db } = await connect(undefined, "bookingops_test")));
after(async () => client.close());

const intent = (id, o = {}) => ({ id, slotId: "S1", seats: 2, amount: 258, card: "4111222233331111", ...o });
async function rig(faults = {}, { capacity = 10, crashAt = [], leaseMs = 300 } = {}) {
  await reset(db, [{ _id: "S1", tour: "Zipline", capacity }]);
  const g = createGateway({ seed: 3, faults, latencyMs: [2, 6] });
  const port = await g.listen();
  const gw = cardpointe({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 250 });
  const crashes = [...crashAt];
  const crash = (stage) => { if (crashes[0] === stage) { crashes.shift(); throw new CrashError(stage); } };
  const stats = {};
  const robust = makeRobust({ client, db, gw, crash, leaseMs, stats });
  const live = (id) => g.ledger().filter((t) => t.orderid.startsWith(id + "~") && t.respstat === "A" && !t.voided);
  const slot = () => db.collection("slots").findOne({ _id: "S1" });
  const bookings = (id) => db.collection("bookings").countDocuments(id ? { intentId: id } : {});
  return { g, gw, robust, stats, live, slot, bookings, crash, close: async () => { await robust.drain(); await g.close(); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("lost answer after the auth went through: inquire finds it, no second auth", async () => {
  const r = await rig({ script: ["dropAfter"] });
  const out = await r.robust.checkout(intent("A1"), "A1-k1");
  assert.equal(out.status, "confirmed");
  assert.equal(r.live("A1").length, 1);
  assert.equal(r.g.stats().auth, 1);
  assert.equal(r.stats.inquire_found_approved, 1);
  assert.equal(await r.bookings("A1"), 1);
  await r.close();
});

test("legacy pattern, same lost answer: the customer's retry charges the card again", async () => {
  const r = await rig({ script: ["dropAfter", "ok"] });
  const first = await legacyCheckout({ db, gw: r.gw }, intent("L1"));
  const retry = await legacyCheckout({ db, gw: r.gw }, intent("L1"));
  assert.deepEqual([first.status, retry.status], ["error", "confirmed"]);
  assert.equal(r.live("L1").filter((t) => t.captured).length, 2, "two captured charges for one booking");
  await r.close();
});

test("request never processed: inquire says 'Txn not found' (29), then one new auth", async () => {
  const r = await rig({ script: ["dropBefore", "ok"] });
  const out = await r.robust.checkout(intent("A2"), "A2-k1");
  assert.equal(out.status, "confirmed");
  assert.equal(r.stats.inquire_not_found, 1);
  assert.equal(r.g.stats().auth, 2);
  assert.equal(r.live("A2").length, 1);
  await r.close();
});

test("'Timed out' (respstat B, 62) and a 5xx are both checked before retrying", async () => {
  const r = await rig({ script: ["timedOut", "http500", "ok"] });
  const out = await r.robust.checkout(intent("A3"), "A3-k1");
  assert.equal(out.status, "confirmed");
  assert.equal(r.stats.inquire_not_found, 2);
  assert.equal(r.live("A3").length, 1);
  await r.close();
});

test("inquiry unreachable too: voidByOrderid, seats released, customer told payment is unavailable", async () => {
  const r = await rig({ script: ["dropAfter"], followupScript: ["drop", "drop", "ok"] });
  const out = await r.robust.checkout(intent("A4"), "A4-k1");
  assert.equal(out.status, "payment_unavailable");
  assert.equal(r.live("A4").length, 0, "the approved auth was voided");
  assert.equal(r.stats.void_by_orderid, 1);
  const s = await r.slot(); assert.equal(s.held, 0); assert.deepEqual(s.holdKeys, []);
  await r.close();
});

test("worker dies right after the approval: the retry with the same key books once, no new auth", async () => {
  const r = await rig({}, { crashAt: ["after_auth_response"] });
  await assert.rejects(r.robust.checkout(intent("A5"), "A5-k1"), CrashError);
  assert.equal((await r.robust.checkout(intent("A5"), "A5-k1")).status, "in_progress", "lease still held by the dead worker");
  await sleep(320);
  const out = await r.robust.checkout(intent("A5"), "A5-k1");
  assert.equal(out.status, "confirmed");
  assert.equal(r.g.stats().auth, 1);
  assert.equal(await r.bookings("A5"), 1);
  await r.close();
});

test("worker dies between hold and auth: the reconciler finishes it, seats counted once", async () => {
  const r = await rig({}, { crashAt: ["after_hold"] });
  await assert.rejects(r.robust.checkout(intent("A6"), "A6-k1"), CrashError);
  assert.equal((await r.slot()).held, 2);
  await sleep(320);
  const rec = await r.robust.reconcile();
  assert.equal(rec.resumed, 1);
  const s = await r.slot(); assert.equal(s.booked, 2); assert.equal(s.held, 0);
  assert.equal(r.live("A6").length, 1);
  await r.close();
});

test("worker dies after the booking is written: capture still happens exactly once", async () => {
  const r = await rig({}, { crashAt: ["after_confirm"] });
  await assert.rejects(r.robust.checkout(intent("A7"), "A7-k1"), CrashError);
  await sleep(320);
  const rec = await r.robust.reconcile();
  assert.equal(rec.captured, 1);
  assert.equal(r.live("A7").filter((t) => t.captured).length, 1);
  await r.close();
});

test("double-click: same key twice at once gives one auth and one booking", async () => {
  const r = await rig({}, { leaseMs: 2000 });
  const outs = await Promise.all([r.robust.checkout(intent("A8"), "A8-k1"), r.robust.checkout(intent("A8"), "A8-k1")]);
  assert.deepEqual(outs.map((o) => o.status).sort(), ["confirmed", "in_progress"]);
  assert.equal(r.g.stats().auth, 1);
  assert.equal((await r.robust.checkout(intent("A8"), "A8-k1")).replay, true);
  await r.close();
});

test("last 2 seats, 12 customers at once: exactly one party books (legacy oversells)", async () => {
  let r = await rig({}, { capacity: 2 });
  const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => r.robust.checkout(intent(`R${i}`), `R${i}-k1`)));
  assert.equal(outs.filter((o) => o.status === "confirmed").length, 1);
  assert.equal((await r.slot()).booked, 2);
  await r.close();
  r = await rig({}, { capacity: 2 });
  const legacy = await Promise.all(Array.from({ length: 12 }, (_, i) => legacyCheckout({ db, gw: r.gw }, intent(`Q${i}`))));
  assert.ok(legacy.filter((o) => o.status === "confirmed").length > 1, "legacy count-then-insert lets several through");
  await r.close();
});

test("declined card: seats go back right away", async () => {
  const r = await rig();
  const out = await r.robust.checkout(intent("A9", { card: "4111222233330002" }), "A9-k1");
  assert.equal(out.status, "declined");
  const s = await r.slot(); assert.equal(s.held, 0); assert.equal(s.booked, 0);
  await r.close();
});

test("hold swept while the auth was out and the seats were resold: auth voided, nobody oversold", async () => {
  const r = await rig({}, { capacity: 2, crashAt: ["after_hold"] });
  await assert.rejects(r.robust.checkout(intent("B1"), "B1-k1"), CrashError);
  await db.collection("slots").updateOne({ _id: "S1" }, { $set: { held: 0, holdKeys: [], booked: 2 } });   // swept + resold meanwhile
  await sleep(320);
  const out = await r.robust.checkout(intent("B1"), "B1-k1");
  assert.equal(out.status, "sold_out");
  assert.equal(r.live("B1").length, 0, "the approval was voided");
  assert.equal((await r.slot()).booked, 2);
  await r.close();
});

test("worker dies after the seats were booked but before the booking row: resume counts the seats once", async () => {
  const r = await rig({}, { crashAt: ["after_seats_booked"] });
  await assert.rejects(r.robust.checkout(intent("B2"), "B2-k1"), CrashError);
  await sleep(320);
  assert.equal((await r.robust.checkout(intent("B2"), "B2-k1")).status, "confirmed");
  const s = await r.slot(); assert.equal(s.booked, 2); assert.equal(s.held, 0);
  assert.equal(await r.bookings("B2"), 1); assert.equal(r.g.stats().auth, 1);
  await r.close();
});

test("seats only on hold for someone else: the customer is told to wait, not 'sold out'", async () => {
  const r = await rig({}, { capacity: 2, crashAt: ["after_hold"] });
  await assert.rejects(r.robust.checkout(intent("B3"), "B3-k1"), CrashError);
  assert.equal((await r.robust.checkout(intent("B4"), "B4-k1")).status, "held_by_others");
  await r.close();
});
