// A CardPointe-shaped test gateway (not CardPointe): same REST paths and response fields the
// integration code uses, plus fault injection that matches the failure cases CardPointe's
// "Handling Timed-out Transactions" guide describes:
//   - no response at all (the auth may or may not have been processed: "your application can
//     not determine whether or not the transaction was successful")
//   - a "Timed out" response (respstat B, respcode 62): retry
//   - inquireByOrderid returns respcode 29 "Txn not found" when the auth never got processed
// It keeps a ledger of every authorization so the benchmark can count double and orphaned auths.
import http from "node:http";

export function rng(seed = 1) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function createGateway({ seed = 1, faults = {}, latencyMs = [20, 60] } = {}) {
  const R = rng(seed);
  const f = { dropAfter: 0, dropBefore: 0, timedOut: 0, http500: 0, followupDrop: 0, declineCard: (acct) => String(acct).endsWith("0002"), ...faults };
  const counts = { auth: 0, inquire: 0, voidByOrderid: 0, capture: 0, void: 0 };
  const byRetref = new Map(), byOrder = new Map(); let seq = 100000;
  const ledger = () => [...byRetref.values()];
  const stats = () => ({ ...counts });
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const delay = () => new Promise((r) => setTimeout(r, latencyMs[0] + R() * (latencyMs[1] - latencyMs[0])));

  async function handle(req, res, body) {
    const url = new URL(req.url, "http://x"), p = url.pathname.replace(/^\/cardconnect\/rest/, "");
    await delay();
    const roll = R();
    // faults apply to auth requests only; the follow-up calls are reliable unless configured
    if (p === "/auth") {
      counts.auth++;
      // tests can force outcomes in order with faults.script = ["dropAfter", "ok", ...]
      const c = [f.dropBefore, f.http500, f.timedOut, f.dropAfter].reduce((acc, x) => (acc.push((acc.at(-1) || 0) + x), acc), []);
      const mode = f.script?.length ? f.script.shift() : roll < c[0] ? "dropBefore" : roll < c[1] ? "http500" : roll < c[2] ? "timedOut" : roll < c[3] ? "dropAfter" : "ok";
      if (mode === "dropBefore") return;                                        // never processed, never answered
      if (mode === "http500") return json(res, 500, { error: "internal" });
      if (mode === "timedOut") return json(res, 200, { respstat: "B", respcode: "62", resptext: "Timed out", orderid: body.orderid });
      const declined = !!f.declineCard(body.account);
      const t = { retref: String(seq++), orderid: body.orderid, amount: body.amount, account: body.account, respstat: declined ? "C" : "A", respcode: declined ? "05" : "00",
        resptext: declined ? "Do not honor" : "Approval", captured: false, voided: false, capture: body.capture === "Y", t: Date.now() };
      if (t.respstat === "A" && t.capture) t.captured = true;
      byRetref.set(t.retref, t); if (body.orderid) byOrder.set(body.orderid, t);
      if (mode === "dropAfter") return;                                         // processed, but the answer is lost
      return json(res, 200, { respstat: t.respstat, respcode: t.respcode, resptext: t.resptext, retref: t.retref, amount: t.amount, orderid: t.orderid });
    }
    if (f.followupScript?.length ? f.followupScript.shift() === "drop" : roll < f.followupDrop) return;   // follow-up calls can be lost too
    if (p === "/capture") { counts.capture++; const t = byRetref.get(body.retref); if (!t || t.respstat !== "A" || t.voided) return json(res, 200, { respstat: "C", respcode: "29", resptext: "Txn not found" });
      t.captured = true; return json(res, 200, { respstat: "A", respcode: "00", resptext: "Approval", retref: t.retref, setlstat: "Queued for Capture" }); }
    if (p === "/void") { counts.void++; const t = byRetref.get(body.retref); if (!t) return json(res, 200, { respstat: "C", respcode: "29", resptext: "Txn not found" });
      if (t.captured) return json(res, 200, { respstat: "C", respcode: "32", resptext: "Already captured: refund instead" });
      t.voided = true; return json(res, 200, { respstat: "A", respcode: "00", resptext: "Approval", retref: t.retref }); }
    let m;
    if ((m = /^\/inquireByOrderid\/([^/]+)\/([^/]+)/.exec(p))) { counts.inquire++; const t = byOrder.get(decodeURIComponent(m[1]));
      if (!t) return json(res, 200, { respstat: "C", respcode: "29", resptext: "Txn not found" });
      return json(res, 200, { respstat: t.respstat, respcode: t.respcode, resptext: t.resptext, retref: t.retref, orderid: t.orderid, amount: t.amount, voided: t.voided ? "Y" : "N", setlstat: t.captured ? "Queued for Capture" : "Authorized" }); }
    if ((m = /^\/voidByOrderid\/([^/]+)\/([^/]+)/.exec(p))) { counts.voidByOrderid++; const t = byOrder.get(decodeURIComponent(m[1]));
      if (!t) return json(res, 200, { respstat: "C", respcode: "29", resptext: "Txn not found" });
      if (t.captured) return json(res, 200, { respstat: "C", respcode: "32", resptext: "Already captured: refund instead" });
      t.voided = true; return json(res, 200, { respstat: "A", respcode: "00", resptext: "Approval", retref: t.retref }); }
    json(res, 404, { error: "not found" });
  }
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { let body = {}; try { body = b ? JSON.parse(b) : {}; } catch {} handle(req, res, body).catch((e) => json(res, 500, { error: e.message })); });
  });
  server.keepAliveTimeout = 5000;
  return { server, ledger, stats, listen: (port = 0) => new Promise((r) => server.listen(port, "127.0.0.1", () => r(server.address().port))), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
