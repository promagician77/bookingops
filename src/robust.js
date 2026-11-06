// Checkout as a resumable state machine keyed by the client's idempotency key.
//   new -> authorizing -> confirmed (captured false -> true)
//     \-> failed (sold_out | held_by_others | declined | payment_unavailable | expired)
// - Seats are held with one conditional update (booked + held + n <= capacity) that also records
//   the key on the slot, so two customers can never both get the last seats and a retried hold
//   or release is a no-op.
// - Every auth gets its own order id (key + sequence). When an auth gets no answer, a 5xx or a
//   "Timed out" (respstat B), that order id is looked up with inquireByOrderid BEFORE any new
//   auth, as CardPointe's "Handling Timed-out Transactions" guide describes. If the lookup gets
//   no answer either, voidByOrderid is tried 3 times.
// - Auth only (capture N). Seats move held -> booked in one idempotent update; booking + attempt
//   state change in one MongoDB transaction; the capture runs after the customer is confirmed.
// - One worker per key (a lease with an owner token, renewed before each gateway call). A worker
//   that dies leaves its lease to expire; the next try with the same key, or the reconciler,
//   carries on from the saved state, so a crash or a lost response never charges twice.
import { randomUUID } from "node:crypto";
import { CrashError } from "./db.js";

export const HOLD_MS = 15 * 60 * 1000;
export class LostLease extends Error {}
const EPOCH = new Date(0);

export function makeRobust({ client, db, gw, crash = () => {}, leaseMs = 3000, stats = {}, trace = () => {} }) {
  const slots = db.collection("slots"), attempts = db.collection("attempts"), bookings = db.collection("bookings");
  const now = () => new Date(), until = () => new Date(Date.now() + leaseMs);
  const bump = (k) => (stats[k] = (stats[k] || 0) + 1);
  const pending = new Set();

  async function hold(key, a) {
    const r = await slots.updateOne({ _id: a.slotId, holdKeys: { $ne: key }, $expr: { $lte: [{ $add: ["$booked", "$held", a.seats] }, "$capacity"] } },
      { $inc: { held: a.seats }, $push: { holdKeys: key } });
    if (r.modifiedCount) return true;
    return !!(await slots.findOne({ _id: a.slotId, holdKeys: key }, { projection: { _id: 1 } }));   // held by an earlier try
  }
  const unhold = (key, a) => slots.updateOne({ _id: a.slotId, holdKeys: key }, { $inc: { held: -a.seats }, $pull: { holdKeys: key } });

  async function fail(key, a, reason, fromStates = ["new", "authorizing"]) {
    await attempts.updateOne({ _id: key, state: { $in: fromStates } }, { $set: { state: "failed", reason, leaseUntil: EPOCH, updatedAt: now() } });
    await unhold(key, a);
    bump(`end_${reason}`); trace(a.intentId, "released", { reason });
    return { status: reason };
  }

  // What happened to an auth whose answer we never got?
  async function resolve(a, renew) {
    for (let i = 0; i < 2; i++) {
      await renew();
      const q = await gw.inquireByOrderid(a.orderid);
      if (q.noResponse || q.httpError) { bump("inquire_no_answer"); continue; }
      if (q.respcode === "29") { bump("inquire_not_found"); return { r: "not_found" }; }
      if (q.respstat === "A" && q.voided !== "Y") { bump("inquire_found_approved"); return { r: "approved", retref: q.retref }; }
      bump("inquire_found_declined"); return { r: "declined" };
    }
    for (let i = 0; i < 3; i++) { await renew(); const v = await gw.voidByOrderid(a.orderid); if (!v.noResponse && !v.httpError) { bump("void_by_orderid"); return { r: "voided" }; } }
    bump("unresolved"); return { r: "unknown" };
  }

  function captureLater(key, retref) {
    const p = (async () => { const c = await gw.capture(retref); if (c.respstat === "A") await attempts.updateOne({ _id: key }, { $set: { captured: true } }); })().catch(() => {});
    pending.add(p); p.finally(() => pending.delete(p));
  }

  // Seats move from held to booked on the slot first (one atomic, idempotent update: the key is
  // moved from holdKeys to bookedKeys). Then the booking and the attempt state change together in
  // a transaction that does not touch the busy slot document, so it never fights other holds.
  async function confirm(key, a, tok, retref) {
    let s = await slots.updateOne({ _id: a.slotId, holdKeys: key }, { $inc: { held: -a.seats, booked: a.seats }, $pull: { holdKeys: key }, $push: { bookedKeys: key } });
    if (!s.modifiedCount && !(await slots.findOne({ _id: a.slotId, bookedKeys: key }, { projection: { _id: 1 } })))
      // hold was swept (expired) while the auth was out: book only if there is still room
      s = await slots.updateOne({ _id: a.slotId, bookedKeys: { $ne: key }, $expr: { $lte: [{ $add: ["$booked", "$held", a.seats] }, "$capacity"] } }, { $inc: { booked: a.seats }, $push: { bookedKeys: key } });
    else s = { modifiedCount: 1 };
    if (!s.modifiedCount) { await gw.void(retref); bump("voided_no_room"); return fail(key, a, "sold_out"); }
    crash("after_seats_booked");
    const session = client.startSession(); let done = false;
    try {
      await session.withTransaction(async () => {
        const st = await attempts.findOneAndUpdate({ _id: key, state: "authorizing", owner: tok }, { $set: { state: "confirmed", retref, captured: false, leaseUntil: EPOCH, updatedAt: now() } }, { session });
        if (!st) { done = false; return; }
        await bookings.insertOne({ intentId: a.intentId, attemptId: key, slotId: a.slotId, seats: a.seats, amount: a.amount, retref, status: "confirmed", flow: "robust", at: now() }, { session });
        done = true;
      });
    } finally { await session.endSession(); }
    if (!done) return { status: "in_progress" };
    trace(a.intentId, "confirmed", {}); bump("end_confirmed");
    crash("after_confirm");
    captureLater(key, retref);
    return { status: "confirmed" };
  }

  async function checkout(intent, key) {
    const tok = randomUUID();
    let a = null;
    try {
      a = await attempts.findOneAndUpdate({ _id: key, leaseUntil: { $lt: now() } },
        { $setOnInsert: { intentId: intent.id, slotId: intent.slotId, seats: intent.seats, amount: intent.amount, card: intent.card, state: "new", authSeq: 0, createdAt: now() },
          $set: { leaseUntil: until(), owner: tok } }, { upsert: true, returnDocument: "after" });
    } catch (e) { if (e.code !== 11000) throw e; }      // exists and another worker holds the lease
    if (!a) {
      const cur = await attempts.findOne({ _id: key });
      if (cur?.state === "confirmed") return { status: "confirmed", replay: true };
      return cur?.state === "failed" ? { status: cur.reason, replay: true } : { status: "in_progress" };
    }
    const renew = async () => { const r = await attempts.updateOne({ _id: key, owner: tok }, { $set: { leaseUntil: until() } }); if (!r.matchedCount) throw new LostLease(key); };
    let dead = false;
    try { return await run(key, a, tok, renew); }
    catch (e) { if (e instanceof CrashError) dead = true; throw e; }
    finally { if (!dead) await attempts.updateOne({ _id: key, owner: tok, leaseUntil: { $gt: EPOCH } }, { $set: { leaseUntil: EPOCH } }); }   // a dead worker frees nothing
  }

  async function run(key, a, tok, renew) {
    if (a.state === "confirmed") { if (!a.captured) captureLater(key, a.retref); return { status: "confirmed", replay: true }; }
    if (a.state === "failed") return { status: a.reason, replay: true };
    if (a.state === "new") {
      const ok = await hold(key, a);
      trace(a.intentId, "hold", { ok, seats: a.seats });
      if (!ok) {   // full, or only full because of other customers' holds (they may still free up)
        const sl = await slots.findOne({ _id: a.slotId }, { projection: { booked: 1, capacity: 1 } });
        return fail(key, a, sl && sl.booked + a.seats <= sl.capacity ? "held_by_others" : "sold_out", ["new"]);
      }
      crash("after_hold");
    }
    for (let tries = 0; ; tries++) {
      if (a.state === "authorizing") {                 // an auth went out and its outcome is unknown
        const q = await resolve(a, renew);
        trace(a.intentId, "inquire", { result: q.r });
        if (q.r === "approved") return confirm(key, a, tok, q.retref);
        if (q.r === "declined") return fail(key, a, "declined");
        if (q.r !== "not_found") return fail(key, a, "payment_unavailable");
        // "Txn not found": never processed, safe to send again
      }
      if (tries >= 3) return fail(key, a, "payment_unavailable");
      const seq = (a.authSeq || 0) + 1, orderid = `${a.intentId}~${key.slice(-4)}-${seq}`;
      const w = await attempts.updateOne({ _id: key, owner: tok }, { $set: { state: "authorizing", orderid, leaseUntil: until(), updatedAt: now() }, $inc: { authSeq: 1 } });
      if (!w.matchedCount) throw new LostLease(key);
      Object.assign(a, { state: "authorizing", orderid, authSeq: seq });
      crash("before_auth");
      trace(a.intentId, "auth", { orderid });
      const r = await gw.auth({ account: a.card, expiry: "1228", amount: String(a.amount), orderid, capture: "N" });
      trace(a.intentId, "auth_result", { respstat: r.respstat || (r.noResponse ? "none" : "5xx") });
      crash("after_auth_response");
      if (r.respstat === "A") return confirm(key, a, tok, r.retref);
      if (r.respstat === "C") return fail(key, a, "declined");
      bump(r.noResponse ? "auth_no_answer" : r.httpError ? "auth_5xx" : "auth_timed_out");
    }
  }

  // Background job: finish or unwind whatever a dead worker or a lost response left behind.
  async function reconcile() {
    const out = { resumed: 0, expired: 0, holdsSwept: 0, captured: 0 };
    const cutoff = new Date(Date.now() - HOLD_MS);
    for (const a of await attempts.find({ state: "new", createdAt: { $lt: cutoff }, leaseUntil: { $lt: now() } }).toArray()) { out.expired++; await fail(a._id, a, "expired", ["new"]); }
    for (const a of await attempts.find({ state: { $in: ["new", "authorizing"] }, leaseUntil: { $lt: now() } }).toArray()) {
      out.resumed++; bump("reconciler_resumed"); await checkout({ id: a.intentId }, a._id).catch(() => {});
    }
    for (const s of await slots.find({ "holdKeys.0": { $exists: true } }).toArray()) for (const key of s.holdKeys) {
      const a = await attempts.findOne({ _id: key });
      if (a && (a.state === "failed" || a.state === "confirmed")) { const r = await unhold(key, a); out.holdsSwept += r.modifiedCount; }
    }
    for (const a of await attempts.find({ state: "confirmed", captured: false }).toArray()) {
      const c = await gw.capture(a.retref); if (c.respstat === "A") { out.captured++; await attempts.updateOne({ _id: a._id }, { $set: { captured: true } }); }
    }
    return out;
  }
  const drain = () => Promise.all([...pending]);
  return { checkout, reconcile, drain };
}
