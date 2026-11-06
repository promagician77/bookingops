// Stand-in for an older reservation service: PHP-style endpoints, strings everywhere, US dates,
// 12-hour local times with no zone, HTTP 200 with status "ERR" for errors. One planted rule
// difference ("Sold" also counts cancelled bookings) so the parity check has something to find.
import http from "node:http";
import { TOURS, slotId } from "./data.js";

const usDate = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const isoDate = (us) => `${us.slice(6, 10)}-${us.slice(0, 2)}-${us.slice(3, 5)}`;
export const to12 = (hm) => { let [h, m] = hm.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; };
export const from12 = (s) => { const [, h, m, ap] = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(s); let H = +h % 12; if (ap === "PM") H += 12; return `${String(H).padStart(2, "0")}:${m}`; };

export function createLegacyApi({ slots, bookings, countsCancelled = true, latencyMs = 4 }) {
  const S = new Map(slots.map((s) => [s._id, { ...s }])), B = new Map(bookings.map((b) => [b._id, { ...b }]));
  const sold = (id) => [...B.values()].filter((b) => b.slotId === id && (countsCancelled || b.status === "confirmed")).reduce((n, b) => n + b.party, 0);
  const send = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => setTimeout(() => {
      const u = new URL(req.url, "http://x"), q = u.searchParams, f = new URLSearchParams(body);
      if (u.pathname === "/api/getAvail.php") {
        const date = isoDate(q.get("date") || ""), rows = [...S.values()].filter((s) => s.tour === q.get("tour") && s.date === date);
        return send(res, { status: "OK", rows: rows.map((s) => ({ TourID: s.tour, Time: to12(s.time), Cap: String(s.capacity), Sold: String(sold(s._id)) })) });
      }
      if (u.pathname === "/api/getRes.php") {
        const b = B.get(q.get("conf")); if (!b) return send(res, { status: "ERR", msg: "NOT FOUND" });
        const s = S.get(b.slotId);
        return send(res, { status: "OK", res: { ConfNo: b._id, Guest: `${b.last}, ${b.first}`, Pax: String(b.party), TourID: s.tour, Date: usDate(s.date), Time: to12(s.time), Total: (b.totalCents / 100).toFixed(2), Status: b.status === "confirmed" ? "C" : "X" } });
      }
      if (u.pathname === "/api/moveRes.php" && req.method === "POST") {
        const b = B.get(f.get("conf")); if (!b) return send(res, { status: "ERR", msg: "NOT FOUND" });
        if (b.status !== "confirmed") return send(res, { status: "ERR", msg: "CANCELLED" });
        const to = S.get(slotId(S.get(b.slotId).tour, isoDate(f.get("date")), from12(f.get("time"))));
        if (!to) return send(res, { status: "ERR", msg: "NO SUCH TIME" });
        if (sold(to._id) + b.party > to.capacity) return send(res, { status: "ERR", msg: "FULL" });
        b.slotId = to._id; return send(res, { status: "OK" });
      }
      res.writeHead(404); res.end();
    }, latencyMs));
  });
  return { listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
export { TOURS };
