// The checkout pattern found in a lot of booking code (not your code; I haven't seen it):
// count seats, charge the card (auth + capture in one call), then write the booking.
// Each customer retry is a fresh request with a fresh order id.
export async function legacyCheckout({ db, gw, crash = () => {}, trace = () => {} }, intent) {
  const slots = db.collection("slots"), bookings = db.collection("bookings");
  const slot = await slots.findOne({ _id: intent.slotId });
  const [agg] = await bookings.aggregate([{ $match: { slotId: intent.slotId, status: "confirmed" } }, { $group: { _id: null, seats: { $sum: "$seats" } } }]).toArray();
  const taken = agg?.seats || 0;
  trace(intent.id, "count", { taken, seats: intent.seats, capacity: slot.capacity });
  if (taken + intent.seats > slot.capacity) return { status: "sold_out" };
  crash("after_availability_check");
  const orderid = `${intent.id}~L${Math.random().toString(36).slice(2, 8)}`;
  trace(intent.id, "auth", { orderid });
  const r = await gw.auth({ account: intent.card, expiry: "1228", amount: String(intent.amount), orderid, capture: "Y" });
  trace(intent.id, "auth_result", { respstat: r.respstat || (r.noResponse ? "none" : "5xx") });
  if (r.noResponse || r.httpError || r.respstat === "B") return { status: "error" };
  if (r.respstat === "C") return { status: "declined" };
  crash("after_payment");
  await bookings.insertOne({ intentId: intent.id, slotId: intent.slotId, seats: intent.seats, amount: intent.amount, retref: r.retref, status: "confirmed", flow: "legacy", at: new Date() });
  trace(intent.id, "confirmed", {});
  return { status: "confirmed" };
}
