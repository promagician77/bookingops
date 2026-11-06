// The booking rush used by the chaos bench: 40 departures across 5 tours, Zipf-hot demand
// (the first few departures get most of the requests), parties of 1-4, ~6% declining cards,
// arrivals spread over 1.5 s.
import { rng } from "./gateway.js";

export function makeWorkload(seed, N = 220) {
  const R = rng(seed * 7919 + 13);
  const tours = ["Zipline", "Doors-off heli", "Sunrise kayak", "ATV ridge", "Waterfall hike"];
  const slots = Array.from({ length: 40 }, (_, i) => ({ _id: `S${String(i + 1).padStart(2, "0")}`, tour: tours[i % tours.length], start: `${8 + (i % 9)}:00`, capacity: 6 + Math.floor(R() * 9) }));
  const w = slots.map((_, i) => 1 / Math.pow(i + 1, 1.1)), W = w.reduce((a, b) => a + b, 0);
  const pick = () => { let x = R() * W; for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return slots[i]._id; } return slots.at(-1)._id; };
  const intents = Array.from({ length: N }, (_, i) => {
    const seats = 1 + Math.floor(R() * 4), decline = R() < 0.06;
    return { id: `I${seed}-${String(i).padStart(4, "0")}`, slotId: pick(), seats, amount: seats * (89 + Math.floor(R() * 4) * 40),
      card: `4111${String(Math.floor(R() * 1e8)).padStart(8, "0")}${decline ? "0002" : "1111"}`, arrive: Math.floor(R() * 1500) };
  });
  return { slots, intents };
}

