import { MongoClient } from "mongodb";

export async function connect(uri = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/?replicaSet=rs0", dbName = "bookingops") {
  const client = new MongoClient(uri, { maxPoolSize: 100 }); await client.connect();
  return { client, db: client.db(dbName) };
}

// slots: { _id, tour, start, capacity, booked, held }  (legacy code ignores booked/held and counts bookings)
export async function reset(db, slots) {
  for (const c of ["slots", "bookings", "attempts"]) await db.collection(c).drop().catch(() => {});
  await db.collection("slots").insertMany(slots.map((s) => ({ booked: 0, held: 0, ...s })));
  await db.collection("bookings").createIndex({ slotId: 1, status: 1 });
  await db.collection("bookings").createIndex({ intentId: 1 });
  await db.collection("bookings").createIndex({ attemptId: 1 }, { unique: true, partialFilterExpression: { attemptId: { $exists: true } } });
  await db.collection("attempts").createIndex({ state: 1, leaseUntil: 1 });
}

export class CrashError extends Error { constructor(stage) { super(`crash at ${stage}`); this.stage = stage; } }
// deterministic "the worker died here" injection
export function crasher(R, p) { const log = []; const f = (stage) => { if (p > 0 && R() < p) { log.push(stage); throw new CrashError(stage); } }; f.log = log; return f; }
