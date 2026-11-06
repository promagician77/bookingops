// Webhook checks, cross-checked against the official SDKs (twilio 6.x validateRequest /
// validateRequestWithBody / getExpectedTwilioSignature, telnyx 7.x TelnyxWebhook.verify).
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { twilioSignature, verifyTwilio, verifyTwilioJson, publicUrl, verifyTelnyx, telnyxKey, mergeCallEvent } from "../src/webhooks.js";
import { rng } from "../src/gateway.js";
const require = createRequire(import.meta.url);
const twilio = require("twilio");
const { TelnyxWebhook } = require("telnyx/lib/webhooks.js");

const R = rng(42);
const pick = (a) => a[Math.floor(R() * a.length)];
const word = (n = 6) => Array.from({ length: n }, () => pick("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-+.@'ʻāēīōū你好")).join("");
const t0 = performance.now(); const res = { when: new Date().toISOString(), sdk: { twilio: require("twilio/package.json").version, telnyx: JSON.parse(fs.readFileSync("node_modules/telnyx/package.json")).version } };

// 1. Twilio form-encoded callbacks
{
  let sigSame = 0, bothAccept = 0, bothRejectTampered = 0, n = 2000, disagree = [];
  for (let i = 0; i < n; i++) {
    const token = crypto.randomBytes(16).toString("hex");
    const url = `${pick(["https", "http"])}://${pick(["book.example.com", "voice.example.org"])}${pick(["", ":8443"])}/${pick(["voice", "sms", "status"])}/${word(4).replace(/[^a-z]/gi, "x")}${pick(["", "?loc=kauai", "?a=1&b=2"])}`;
    const params = {}; for (let k = 0, m = 3 + Math.floor(R() * 12); k < m; k++) params[pick(["CallSid", "From", "To", "CallStatus", "Body", "Digits", "SpeechResult", "Caller", "Direction", "ApiVersion", "AccountSid", "RecordingUrl"]) + (k > 9 ? k : "")] = word(3 + Math.floor(R() * 20));
    const ours = twilioSignature(token, url, params), theirs = twilio.getExpectedTwilioSignature(token, url, params);
    if (ours === theirs) sigSame++; else if (disagree.length < 3) disagree.push({ url, params });
    if (verifyTwilio({ authToken: token, url, params, signature: theirs }) && twilio.validateRequest(token, theirs, url, params)) bothAccept++;
    const k = pick(Object.keys(params)), tampered = { ...params, [k]: params[k] + "1" };
    if (!verifyTwilio({ authToken: token, url, params: tampered, signature: theirs }) && !twilio.validateRequest(token, theirs, url, tampered)) bothRejectTampered++;
  }
  res.twilioForm = { cases: n, signatureIdentical: sigSame, bothAccept, bothRejectTampered, disagree };
}
// 2. Twilio JSON bodies (bodySHA256 in the URL)
{
  let n = 400, bothAccept = 0, bothReject = 0;
  for (let i = 0; i < n; i++) {
    const token = crypto.randomBytes(16).toString("hex");
    const body = JSON.stringify({ event: pick(["call.completed", "msg.received"]), sid: word(10), text: word(30) });
    const url = `https://book.example.com/hooks/json?bodySHA256=${crypto.createHash("sha256").update(body).digest("hex")}`;
    const sig = twilio.getExpectedTwilioSignature(token, url, {});
    if (verifyTwilioJson({ authToken: token, url, rawBody: body, signature: sig }) && twilio.validateRequestWithBody(token, sig, url, body)) bothAccept++;
    const bad = body.replace(/"text":"/, '"text":"x');
    if (!verifyTwilioJson({ authToken: token, url, rawBody: bad, signature: sig }) && !twilio.validateRequestWithBody(token, sig, url, bad)) bothReject++;
  }
  res.twilioJson = { cases: n, bothAccept, bothRejectTamperedBody: bothReject };
}
// 3. Behind a TLS-terminating load balancer
{
  const token = "f00dbabe" + "0".repeat(24), params = { CallSid: "CA" + "1".repeat(32), CallStatus: "completed", CallDuration: "184" };
  const signedUrl = "https://book.example.com/voice/status?loc=kauai";
  const sig = twilio.getExpectedTwilioSignature(token, signedUrl, params);
  const req = { url: "/voice/status?loc=kauai", headers: { host: "10.0.0.5:3000", "x-forwarded-proto": "https", "x-forwarded-host": "book.example.com" }, remoteAddress: "10.0.0.2", encrypted: false };
  const naive = `http://${req.headers.host}${req.url}`;
  const rebuilt = publicUrl(req, { trustedProxies: ["10.0.0.2"] });
  const spoof = { ...req, remoteAddress: "203.0.113.9", headers: { ...req.headers, "x-forwarded-host": "evil.example" } };
  res.proxy = {
    appSees: naive, twilioSigned: signedUrl, rebuilt,
    naiveAccepts: verifyTwilio({ authToken: token, url: naive, params, signature: sig }),
    rebuiltAccepts: verifyTwilio({ authToken: token, url: rebuilt, params, signature: sig }),
    untrustedSourceUrl: publicUrl(spoof, { trustedProxies: ["10.0.0.2"] }),
  };
}
// 4. Telnyx Ed25519
{
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const sdk = new TelnyxWebhook(pubB64), sdkOther = new TelnyxWebhook(other), key = telnyxKey(pubB64), keyOther = telnyxKey(other);
  const sdkOk = async (w, body, h) => { try { await w.verify(body, h); return true; } catch { return false; } };
  const cases = { valid: [0, 0], tamperedBody: [0, 0], reserializedJson: [0, 0], staleTimestamp: [0, 0], wrongKey: [0, 0] }; const n = 500;
  for (let i = 0; i < n; i++) {
    const now = Date.now(), ts = String(Math.floor(now / 1000));
    const body = JSON.stringify({ data: { event_type: pick(["call.initiated", "call.answered", "call.hangup", "message.received"]), id: crypto.randomUUID(), payload: { call_control_id: "v3:" + word(12), from: "+1808555" + String(1000 + i).slice(-4), text: word(20) } } }, null, pick([0, 2]));
    const sign = (t, b) => crypto.sign(null, Buffer.from(`${t}|${b}`), privateKey).toString("base64");
    const h = (t, b) => ({ "telnyx-signature-ed25519": sign(t, b), "telnyx-timestamp": t });
    const run = async (name, rawBody, headers, k = key, w = sdk, expect = false) => {
      const a = verifyTelnyx({ publicKey: k, rawBody, headers, now }).ok, b = await sdkOk(w, rawBody, headers);
      if (a === expect && b === expect) cases[name][0]++; if (a === b) cases[name][1]++;
    };
    await run("valid", body, h(ts, body), key, sdk, true);
    await run("tamperedBody", body.replace('"id":', '"id":"x","id_":'), h(ts, body));
    const re = JSON.stringify(JSON.parse(body), null, body.includes("\n") ? 0 : 2);   // same JSON, different bytes
    await run("reserializedJson", re, h(ts, body));
    const old = String(Number(ts) - 301);
    await run("staleTimestamp", body, h(old, body));
    await run("wrongKey", body, h(ts, body), keyOther, sdkOther);
  }
  res.telnyx = { casesEach: n, results: Object.fromEntries(Object.entries(cases).map(([k, [exp, agree]]) => [k, { asExpectedBoth: exp, sdkAgrees: agree }])) };
  // cost per verification
  const body = JSON.stringify({ data: { event_type: "call.hangup", id: crypto.randomUUID() } }), ts = String(Math.floor(Date.now() / 1000));
  const hdr = { "telnyx-signature-ed25519": crypto.sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64"), "telnyx-timestamp": ts };
  let t = performance.now(); for (let i = 0; i < 5000; i++) verifyTelnyx({ publicKey: key, rawBody: body, headers: hdr }); res.telnyx.usPerVerify = +((performance.now() - t) / 5000 * 1000).toFixed(1);
  const tok = "a".repeat(32), url = "https://book.example.com/voice", params = { CallSid: "CA1", CallStatus: "ringing", From: "+18085551234", To: "+18085550000" }, s = twilioSignature(tok, url, params);
  t = performance.now(); for (let i = 0; i < 20000; i++) verifyTwilio({ authToken: tok, url, params, signature: s }); res.twilioForm.usPerVerify = +((performance.now() - t) / 20000 * 1000).toFixed(1);
}
// 5. Call status callbacks with retries and late arrivals
{
  const n = 1000, flows = [["initiated", "ringing", "in-progress", "completed"], ["initiated", "ringing", "no-answer"], ["initiated", "ringing", "busy"], ["initiated", "ringing", "in-progress", "completed"]];
  const truth = new Map(), deliveries = [];
  for (let i = 0; i < n; i++) {
    const sid = "CA" + String(i).padStart(32, "0"), flow = pick(flows), dur = flow.includes("completed") ? (R() < 0.15 ? 1 + Math.floor(R() * 3) : 20 + Math.floor(R() * 600)) : null;
    truth.set(sid, { status: flow.at(-1), duration: dur });
    let t = i * 50;
    for (const st of flow) {
      t += st === "completed" ? dur * 1000 : 300 + R() * 2000;
      let at = t + R() * 400;
      if (st === "in-progress" && dur != null && dur < 4 && R() < 0.5) at += 4000;                   // short call: in-progress lands after completed
      deliveries.push({ callSid: sid, status: st, duration: st === "completed" ? dur : null, at });
      if (R() < 0.06) deliveries.push({ callSid: sid, status: st, duration: st === "completed" ? dur : null, at: at + 5000 + R() * 15000 });   // retried delivery
    }
  }
  deliveries.sort((a, b) => a.at - b.at);
  const naive = new Map(), merged = new Map(), tally = { applied: 0, duplicate: 0, late: 0 };
  for (const d of deliveries) { naive.set(d.callSid, { status: d.status, duration: d.duration }); tally[mergeCallEvent(merged, d)]++; }
  const wrong = (m) => [...truth].filter(([sid, t]) => m.get(sid).status !== t.status).length;
  const lostDur = (m) => [...truth].filter(([sid, t]) => t.duration != null && m.get(sid).duration !== t.duration).length;
  res.callStatus = { calls: n, deliveries: deliveries.length, duplicates: tally.duplicate, lateArrivals: tally.late,
    lastWriteWins: { wrongFinalStatus: wrong(naive), wrongDuration: lostDur(naive) }, rankedMerge: { wrongFinalStatus: wrong(merged), wrongDuration: lostDur(merged) } };
}
res.ms = +(performance.now() - t0).toFixed(0);
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/webhooks.json", JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
