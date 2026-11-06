// Seed data shared by the "old" reservation API and the MongoDB-backed replacement.
import { rng } from "../gateway.js";

export const TOURS = [
  { id: "HELI", name: "Doors-off helicopter", tz: "Pacific/Honolulu", capacity: 6, times: ["08:00", "10:30", "13:00", "15:30"], price: 389 },
  { id: "ZIP", name: "Zipline canopy", tz: "Pacific/Honolulu", capacity: 12, times: ["09:00", "11:00", "14:00"], price: 169 },
  { id: "RAFT", name: "River raft", tz: "America/Los_Angeles", capacity: 10, times: ["09:30", "13:30"], price: 129 },
];
export const DATES = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 10, 6 + i)).toISOString().slice(0, 10));

// local wall time in a named zone -> ISO string with that zone's offset on that date
export function zonedIso(date, hhmm, tz) {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(guess).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const offMin = Math.round((asLocal - guess.getTime()) / 60000);
  const sign = offMin <= 0 ? "-" : "+", a = Math.abs(offMin);
  return `${date}T${hhmm}:00${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
export const slotId = (tour, date, hhmm) => `${tour}-${date}-${hhmm.replace(":", "")}`;

export function seed(n = 320, s = 11) {
  const R = rng(s);
  const first = ["Ana", "Kai", "Leilani", "Marcus", "Priya", "Tom", "Noelani", "Sofia", "Ben", "Hana", "Diego", "Mei"];
  const last = ["Lee", "Kahale", "Ortiz", "Nakamura", "Smith", "Akana", "Patel", "Kim", "Silva", "Brown", "Keawe", "Chen"];
  const slots = [];
  for (const t of TOURS) for (const d of DATES) for (const hm of t.times) slots.push({ _id: slotId(t.id, d, hm), tour: t.id, date: d, time: hm, start: zonedIso(d, hm, t.tz), capacity: t.capacity, booked: 0 });
  const bookings = [];
  const ab = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < n; i++) {
    const sl = slots[Math.floor(R() * slots.length)], tour = TOURS.find((t) => t.id === sl.tour);
    const party = 1 + Math.floor(R() * 4);
    if (sl.booked + party > sl.capacity) continue;
    const cancelled = R() < 0.08;
    if (!cancelled) sl.booked += party;
    const ref = Array.from({ length: 6 }, () => ab[Math.floor(R() * ab.length)]).join("");
    bookings.push({ _id: ref, first: first[Math.floor(R() * first.length)], last: last[Math.floor(R() * last.length)], party, slotId: sl._id, totalCents: party * tour.price * 100, status: cancelled ? "cancelled" : "confirmed" });
  }
  return { slots, bookings };
}
