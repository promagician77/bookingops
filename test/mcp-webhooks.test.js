import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connect } from "../src/db.js";
import { seed } from "../src/mcp/data.js";
import { createLegacyApi } from "../src/mcp/legacy-api.js";
import { legacyAdapter, mongoAdapter } from "../src/mcp/adapters.js";
import { buildServer } from "../src/mcp/server.js";
import { twilioSignature, verifyTwilio, verifyTelnyx, mergeCallEvent, publicUrl } from "../src/webhooks.js";
const require = createRequire(import.meta.url);
const twilio = require("twilio");

let client, db, api, adapters; const data = seed(120, 3);
before(async () => {
  ({ client, db } = await connect(undefined, "bookingops_mcp_test"));
  for (const c of ["slots", "bookings", "audit", "approvals"]) await db.collection(c).drop().catch(() => {});
  await db.collection("slots").insertMany(data.slots.map((s) => ({ ...s }))); await db.collection("bookings").insertMany(data.bookings.map((b) => ({ ...b })));
  api = createLegacyApi({ ...data, countsCancelled: false }); const port = await api.listen();
  adapters = { legacy: legacyAdapter(`http://127.0.0.1:${port}`), mongo: mongoAdapter({ client, db }) };
});
after(async () => { await api.close(); await client.close(); });
async function as(principal, routes = {}) {
  const s = buildServer({ principal, adapters, routes, db }); const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "1" }); await Promise.all([s.connect(a), c.connect(b)]);
  return { c, call: async (name, args) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text) };
}

test("MCP: old API and MongoDB answer get_booking identically through the same tool", async () => {
  const L = await as("call-center-agent", { get_booking: "legacy" }), M = await as("call-center-agent");
  for (const b of data.bookings.slice(0, 40)) assert.deepEqual(await L.call("get_booking", { ref: b._id }), await M.call("get_booking", { ref: b._id }));
});

test("MCP: each caller only sees the tools its scopes allow", async () => {
  const names = async (p) => (await (await as(p)).c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(await names("email-drafter"), ["get_booking", "search_availability"]);
  assert.ok(!(await names("booking-assistant")).includes("approve_change"));
  assert.ok((await names("call-center-agent")).includes("approve_change"));
});

test("MCP: a proposal changes nothing until approved, and an approval works once", async () => {
  const b = data.bookings.find((x) => x.status === "confirmed");
  const target = data.slots.find((s) => s.tour === b.slotId.split("-")[0] && s._id !== b.slotId && s.capacity - s.booked >= b.party);
  const ai = await as("booking-assistant"), human = await as("call-center-agent");
  const p = await ai.call("propose_reschedule", { ref: b._id, to_slot: target._id });
  assert.equal((await db.collection("bookings").findOne({ _id: b._id })).slotId, b.slotId);
  assert.equal((await human.call("approve_change", { approval_id: p.approval_id })).status, "moved");
  assert.equal((await human.call("approve_change", { approval_id: p.approval_id })).error.code, "not_pending");
  assert.ok(await db.collection("audit").countDocuments({ tool: "approve_change", principal: "call-center-agent" }) >= 2);
});

test("Twilio: same signature as the official helper, tampering rejected", () => {
  const token = "12345678901234567890123456789012", url = "https://book.example.com/voice?loc=maui", params = { CallSid: "CA1", From: "+18085551234", Body: "Aloha ʻohana" };
  const s = twilio.getExpectedTwilioSignature(token, url, params);
  assert.equal(twilioSignature(token, url, params), s);
  assert.ok(verifyTwilio({ authToken: token, url, params, signature: s }));
  assert.ok(!verifyTwilio({ authToken: token, url, params: { ...params, Body: "x" }, signature: s }));
  const req = { url: "/voice?loc=maui", headers: { host: "10.0.0.5:3000", "x-forwarded-proto": "https", "x-forwarded-host": "book.example.com" }, remoteAddress: "10.0.0.2" };
  assert.ok(verifyTwilio({ authToken: token, url: publicUrl(req, { trustedProxies: ["10.0.0.2"] }), params, signature: s }));
});

test("Telnyx: Ed25519 over timestamp|raw body; re-serialized JSON and stale timestamps fail", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const body = '{"data":{"event_type":"call.hangup","id":"e1"}}', ts = String(Math.floor(Date.now() / 1000));
  const headers = { "Telnyx-Signature-Ed25519": crypto.sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64"), "Telnyx-Timestamp": ts };
  assert.ok(verifyTelnyx({ publicKey: pub, rawBody: body, headers }).ok);
  assert.equal(verifyTelnyx({ publicKey: pub, rawBody: JSON.stringify(JSON.parse(body), null, 1), headers }).why, "signature mismatch");
  assert.equal(verifyTelnyx({ publicKey: pub, rawBody: body, headers, now: Date.now() + 301000 }).why, "stale timestamp");
});

test("Call status: a late in-progress or a retried ringing never overwrites completed", () => {
  const m = new Map();
  for (const s of ["initiated", "ringing", "completed", "in-progress", "ringing"]) mergeCallEvent(m, { callSid: "CA1", status: s, duration: s === "completed" ? 2 : null });
  assert.equal(m.get("CA1").status, "completed"); assert.equal(m.get("CA1").duration, 2);
});
