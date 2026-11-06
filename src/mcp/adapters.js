// Two backends behind one contract. Every tool answers in the same normalized shape whichever
// backend serves it, so a tool can move from the old API to MongoDB by flipping one route.
//   slot:    { slot_id, tour, start (ISO with the location's offset), capacity, available }
//   booking: { ref, guest: { first, last }, party, slot_id, start, total_cents, status }
import { TOURS, slotId, zonedIso } from "./data.js";
import { to12, from12 } from "./legacy-api.js";

const tz = (tour) => TOURS.find((t) => t.id === tour).tz;
const err = (code, message) => ({ error: { code, message } });

export function legacyAdapter(baseUrl) {
  const get = async (p) => (await fetch(baseUrl + p)).json();
  const usDate = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  const isoDate = (us) => `${us.slice(6, 10)}-${us.slice(0, 2)}-${us.slice(3, 5)}`;
  return {
    name: "legacy",
    async searchAvailability({ tour, date }) {
      const r = await get(`/api/getAvail.php?tour=${encodeURIComponent(tour)}&date=${usDate(date)}`);
      if (r.status !== "OK") return err("upstream", r.msg);
      return { tour, date, slots: r.rows.map((x) => { const hm = from12(x.Time); return { slot_id: slotId(tour, date, hm), tour, start: zonedIso(date, hm, tz(tour)), capacity: +x.Cap, available: Math.max(0, +x.Cap - +x.Sold) }; }) };
    },
    async getBooking({ ref }) {
      const r = await get(`/api/getRes.php?conf=${encodeURIComponent(ref)}`);
      if (r.status !== "OK") return r.msg === "NOT FOUND" ? err("not_found", `no booking ${ref}`) : err("upstream", r.msg);
      const x = r.res, [last, first] = x.Guest.split(", "), date = isoDate(x.Date), hm = from12(x.Time);
      return { ref: x.ConfNo, guest: { first, last }, party: +x.Pax, slot_id: slotId(x.TourID, date, hm), start: zonedIso(date, hm, tz(x.TourID)), total_cents: Math.round(+x.Total * 100), status: x.Status === "C" ? "confirmed" : "cancelled" };
    },
    async moveBooking({ ref, toSlot }) {
      const [, date, hhmm] = /^[A-Z]+-(\d{4}-\d{2}-\d{2})-(\d{4})$/.exec(toSlot) || [];
      if (!date) return err("bad_slot", toSlot);
      const r = await (await fetch(baseUrl + "/api/moveRes.php", { method: "POST", body: new URLSearchParams({ conf: ref, date: usDate(date), time: to12(`${hhmm.slice(0, 2)}:${hhmm.slice(2)}`) }) })).json();
      if (r.status === "OK") return { ref, slot_id: toSlot, status: "moved" };
      return err({ FULL: "full", "NOT FOUND": "not_found", CANCELLED: "cancelled", "NO SUCH TIME": "bad_slot" }[r.msg] || "upstream", r.msg);
    },
  };
}

export function mongoAdapter({ client, db }) {
  const slots = db.collection("slots"), bookings = db.collection("bookings");
  const shape = (s) => ({ slot_id: s._id, tour: s.tour, start: s.start, capacity: s.capacity, available: Math.max(0, s.capacity - s.booked) });
  return {
    name: "mongo",
    async searchAvailability({ tour, date }) {
      const rows = await slots.find({ tour, date }).sort({ time: 1 }).toArray();
      return { tour, date, slots: rows.map(shape) };
    },
    async getBooking({ ref }) {
      const b = await bookings.findOne({ _id: ref }); if (!b) return err("not_found", `no booking ${ref}`);
      const s = await slots.findOne({ _id: b.slotId });
      return { ref: b._id, guest: { first: b.first, last: b.last }, party: b.party, slot_id: b.slotId, start: s.start, total_cents: b.totalCents, status: b.status };
    },
    async moveBooking({ ref, toSlot }) {
      const session = client.startSession(); let out;
      try {
        await session.withTransaction(async () => {
          const b = await bookings.findOne({ _id: ref }, { session });
          if (!b) return (out = err("not_found", `no booking ${ref}`));
          if (b.status !== "confirmed") return (out = err("cancelled", "booking is cancelled"));
          const to = await slots.findOne({ _id: toSlot }, { session });
          if (!to || to.tour !== (await slots.findOne({ _id: b.slotId }, { session })).tour) return (out = err("bad_slot", toSlot));
          const inc = await slots.updateOne({ _id: toSlot, $expr: { $lte: [{ $add: ["$booked", b.party] }, "$capacity"] } }, { $inc: { booked: b.party } }, { session });
          if (!inc.modifiedCount) { out = err("full", "FULL"); return session.abortTransaction(); }
          await slots.updateOne({ _id: b.slotId }, { $inc: { booked: -b.party } }, { session });
          await bookings.updateOne({ _id: ref }, { $set: { slotId: toSlot } }, { session });
          out = { ref, slot_id: toSlot, status: "moved" };
        });
      } finally { await session.endSession(); }
      return out;
    },
  };
}
