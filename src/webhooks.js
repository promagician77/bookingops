// Voice/messaging webhook intake: signature checks for Twilio and Telnyx, the public URL behind a
// TLS-terminating proxy, and call-status merging that survives duplicates and late arrivals.
import crypto from "node:crypto";

// ---- Twilio: HMAC-SHA1 (key = Auth Token) over the full URL + POST params sorted by name,
// each name and value appended with no separator; Base64. JSON bodies: URL carries bodySHA256.
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((s, k) => s + (Array.isArray(params[k]) ? [...new Set(params[k])].sort().map((v) => k + v).join("") : k + params[k]), url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}
const safeEq = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export function verifyTwilio({ authToken, url, params, signature }) {
  // Twilio drops the port for HTTPS voice callbacks and keeps it otherwise, so accept either form
  const m = /^(https?):\/\/([^/:?#]+)(?::(\d+))?(.*)$/.exec(url);
  const forms = m ? [url, `${m[1]}://${m[2]}${m[4]}`, `${m[1]}://${m[2]}:${m[3] || (m[1] === "https" ? 443 : 80)}${m[4]}`] : [url];
  return [...new Set(forms)].some((f) => safeEq(signature, twilioSignature(authToken, f, params)));
}
export function verifyTwilioJson({ authToken, url, rawBody, signature }) {
  const want = new URL(url).searchParams.get("bodySHA256") || "";
  const got = crypto.createHash("sha256").update(Buffer.from(rawBody, "utf-8")).digest("hex");
  return verifyTwilio({ authToken, url, params: {}, signature }) && safeEq(want, got);
}

// The URL Twilio signed is the public one. Behind a load balancer the app sees
// http://10.0.0.5:3000/voice; rebuild the public URL, trusting forwarded headers only from known proxies.
export function publicUrl(req, { trustedProxies = [], publicHost } = {}) {
  const fromProxy = trustedProxies.includes(req.remoteAddress);
  const proto = fromProxy && req.headers["x-forwarded-proto"] ? req.headers["x-forwarded-proto"].split(",")[0].trim() : req.encrypted ? "https" : "http";
  const host = publicHost || (fromProxy && req.headers["x-forwarded-host"]) || req.headers.host;
  return `${proto}://${host}${req.url}`;
}

// ---- Telnyx: Ed25519 over `${timestamp}|${rawBody}`; headers telnyx-signature-ed25519 (Base64,
// 64 bytes) and telnyx-timestamp (Unix seconds). The raw bytes matter: re-serialized JSON fails.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export const telnyxKey = (b64) => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(b64, "base64")]), format: "der", type: "spki" });
export function verifyTelnyx({ publicKey, rawBody, headers, now = Date.now(), toleranceSec = 300 }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const sig = h["telnyx-signature-ed25519"], ts = h["telnyx-timestamp"];
  if (!sig || !ts) return { ok: false, why: "missing headers" };
  if (!/^\d+$/.test(ts)) return { ok: false, why: "bad timestamp" };
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > toleranceSec) return { ok: false, why: "stale timestamp" };
  const s = Buffer.from(sig, "base64"); if (s.length !== 64) return { ok: false, why: "bad signature length" };
  const key = typeof publicKey === "string" ? telnyxKey(publicKey) : publicKey;
  return crypto.verify(null, Buffer.from(`${ts}|${rawBody}`, "utf-8"), key, s) ? { ok: true } : { ok: false, why: "signature mismatch" };
}

// ---- Call status merge. Callbacks can be retried (duplicates) and, as Twilio's support notes
// say, a "completed" can arrive before "in-progress" when a call ends quickly. Rank statuses and
// never move a call backwards; a terminal status is final.
const RANK = { queued: 0, initiated: 1, ringing: 2, "in-progress": 3, answered: 3, completed: 4, busy: 4, "no-answer": 4, failed: 4, canceled: 4 };
export function mergeCallEvent(calls, ev) {
  const cur = calls.get(ev.callSid);
  const key = `${ev.status}`;
  if (cur?.seen.has(key)) return "duplicate";
  if (cur && RANK[ev.status] <= RANK[cur.status]) { cur.seen.add(key); if (ev.duration != null && cur.duration == null) cur.duration = ev.duration; return "late"; }
  calls.set(ev.callSid, { status: ev.status, duration: ev.duration ?? cur?.duration ?? null, seen: new Set([...(cur?.seen || []), key]) });
  return "applied";
}
