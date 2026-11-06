(async function () {
  const D = await (await fetch("data/site.json")).json();
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.innerHTML = html; return e; };
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const usd = (n) => "$" + fmt(Math.round(n));
  const NS = "http://www.w3.org/2000/svg";
  const sv = (tag, a = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
  const txt = (parent, x, y, s, a = {}) => { const t = sv("text", { x, y, ...a }, parent); t.textContent = s; return t; };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------- tabs
  const show = (t) => { document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t)); document.querySelectorAll("section.tab").forEach((s) => s.classList.toggle("on", s.id === "t-" + t)); };
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; show(b.dataset.t); history.replaceState(null, "", "#" + b.dataset.t); });
  if (location.hash) show(location.hash.slice(1));
  addEventListener("hashchange", () => { show(location.hash.slice(1) || "faults"); scrollTo(0, 0); });

  const M = D.chaos.meta, S = D.chaos.summary;
  $("#stamp").innerHTML = `MongoDB ${M.mongo} · Node ${M.node}<br>${M.seeds} seeds × ${M.intentsPerRun} checkouts<br>run ${M.when.slice(0, 10)}`;
  const L = S["faults/legacy"], R = S["faults/robust"];
  $("#faults-lead").innerHTML = `Under the same faults, the old pattern sold <b>${L.oversoldSeats.sum} seats that didn't exist</b>, charged <b>${L.chargedTwice.sum} customers twice</b> and took <b>${L.chargedNoBooking.sum} payments with no booking</b> (${usd(L.refundDue.sum)} to refund). The reworked flow: <b>0, 0 and 0</b>, for about ${Math.round(avg(R.p50.per) - avg(L.p50.per))} ms more at the median.`;
  function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

  // ---------- 01 comparison
  const ROWS = [
    ["oversoldSeats", "Seats sold beyond capacity", (s) => `on ${s.oversoldSlots.sum} departures`, true],
    ["chargedTwice", "Customers charged twice", () => "two live approvals, one order", true],
    ["chargedNoBooking", "Charged, no booking", () => "money taken, nothing booked", true],
    ["refundDue", "Refunds owed", () => "duplicates + charges with no booking", true, usd],
    ["bookings", "Bookings made", () => "the old pattern's extra ones are the oversold seats", false],
    ["waitedCustomers", "Told “on hold for another guest”", (s) => s.waitedCustomers.sum ? `instead of a false “sold out”; ${s.waitedThenBooked.sum} booked after waiting, the rest saw the held seats get booked` : "", false],
    ["inProgressSeen", "Shown “confirming…”, finished in background", () => "worker crashed mid-checkout", false],
    ["lostWithSeatsLeft", "Good card, no booking, seats left", () => "a lost sale", true],
    ["p50", "Median time to confirmation", () => "includes the customer's own retries", false, (v) => `${Math.round(v / 5)} ms`],
  ];
  function drawCmp(sc) {
    const l = S[`${sc}/legacy`], r = S[`${sc}/robust`], box = $("#cmp"); box.innerHTML = "";
    box.append(el("div", { class: "hd m" }, "per 5 runs"), el("div", { class: "hd l" }, "Old pattern"), el("div", { class: "hd r" }, "Reworked"));
    for (const [k, label, sub, badWhenPositive, f = fmt] of ROWS) {
      if (!l[k] || !r[k]) continue;
      box.append(el("div", { class: "m" }, `<b>${label}</b><span>${sub(l) || sub(r) || ""}</span>`));
      for (const s of [l, r]) {
        const v = s[k].sum, mx = Math.max(1, ...l[k].per, ...r[k].per);
        const cls = !badWhenPositive ? "" : v > 0 ? "bad" : "good";
        box.append(el("div", {}, `<div class="val ${cls}"><span class="big">${f(v)}</span><span class="seeds" title="per seed: ${s[k].per.join(", ")}">${s[k].per.map((x) => `<i style="height:${Math.max(2, (22 * x) / mx)}px"></i>`).join("")}</span></div>`));
      }
    }
    $("#scen-note").textContent = sc === "faults" ? "Faults: 3% of auth answers lost after processing, 1% of requests lost before, 1% “Timed out” (B/62), 1% HTTP 5xx, 1% of follow-up calls lost, 1% chance the worker dies at each step. Client timeout 1.2 s." : "No injected faults: only many customers checking out at once.";
  }
  $("#scen").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $("#scen").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); drawCmp(b.dataset.s); });
  drawCmp("faults");

  // ---------- 02 race replay
  const race = D.race;
  if (race) {
    const cap = race.slot.capacity;
    const conf = (lanes) => lanes.filter((l) => l.ev.some((e) => e.e === "confirmed")).reduce((s, l) => s + l.seats, 0);
    $("#race-lead").innerHTML = `One departure from the no-fault run: <b>${race.slot.tour}, ${race.slot.capacity} seats</b>, ${race.legacy.length} parties checking out within a couple of seconds. The old pattern counted seats while other payments were still in flight and booked <b>${conf(race.legacy)}</b>. The reworked flow booked <b>${conf(race.robust)}</b>.`;
    const all = [...race.legacy, ...race.robust].flatMap((l) => l.ev.map((e) => e.t));
    const t0 = Math.min(...all), t1 = Math.max(...all) + 40;
    const draws = [drawRace($("#race-l"), race.legacy, "legacy"), drawRace($("#race-r"), race.robust, "robust")];
    function drawRace(host, lanes, kind) {
      const W = 640, lh = 22, top = 18, H = top + lanes.length * lh + 120, x0 = 92, x1 = W - 14;
      const X = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
      const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${kind} timeline` }); host.appendChild(svg);
      const items = [];
      for (let ms = 0; ms <= t1 - t0; ms += 500) { sv("line", { x1: X(t0 + ms), x2: X(t0 + ms), y1: top - 6, y2: H - 30, stroke: css("--line2") }, svg); txt(svg, X(t0 + ms), H - 16, `${(ms / 1000).toFixed(1)}s`, { "text-anchor": "middle", "font-size": 11, fill: css("--mute"), class: "mono" }); }
      lanes.forEach((l, i) => {
        const y = top + i * lh + lh / 2;
        txt(svg, 8, y + 4, `party of ${l.seats}`, { "font-size": 12, fill: css("--ink2") });
        const g = (t, node) => items.push({ t, node });
        const ev = (n) => l.ev.find((e) => e.e === n);
        const first = l.ev[0];
        const a = ev("auth"), ar = ev("auth_result"), c = ev("confirmed"), h = ev("hold"), cnt = ev("count"), rel = ev("released");
        if (a && ar) g(a.t, sv("rect", { x: X(a.t), y: y - 5, width: Math.max(2, X(ar.t) - X(a.t)), height: 10, rx: 2, fill: css("--sun") }, svg));
        if (cnt) { const d = sv("circle", { cx: X(cnt.t), cy: y, r: 4.5, fill: css("--ink2") }, svg); g(cnt.t, d); const lab = txt(svg, X(cnt.t) - 7, y + 4, `${cnt.taken}`, { "text-anchor": "end", "font-size": 10.5, fill: css("--mute"), class: "mono" }); g(cnt.t, lab); }
        if (h) g(h.t, h.ok ? sv("circle", { cx: X(h.t), cy: y, r: 4.5, fill: css("--ink2") }, svg) : cross(svg, X(h.t), y));
        if (cnt && !a) g(cnt.t + 1, cross(svg, X(cnt.t) + 10, y));
        if (c) g(c.t, sv("path", { d: `M${X(c.t)} ${y - 7} l7 7 l-7 7 l-7 -7 z`, fill: css("--teal") }, svg));
        if (rel && !c && !["sold_out", "held_by_others"].includes(rel.reason)) g(rel.t, sv("circle", { cx: X(rel.t) + 9, cy: y, r: 4, fill: "none", stroke: css("--mute"), "stroke-width": 2 }, svg));
        void first;
      });
      // seat meter
      const my0 = top + lanes.length * lh + 18, mh = 64, MY = (v) => my0 + mh - (v / Math.max(cap + 4, conf(lanes))) * mh;
      sv("line", { x1: x0, x2: x1, y1: MY(cap), y2: MY(cap), stroke: css("--ink"), "stroke-dasharray": "4 3" }, svg);
      txt(svg, 8, MY(cap) + 4, `${cap} seats`, { "font-size": 11.5, fill: css("--ink"), "font-weight": 600 });
      txt(svg, 8, my0 + mh - 2, "booked", { "font-size": 11, fill: css("--mute") });
      const steps = lanes.flatMap((l) => l.ev.filter((e) => e.e === "confirmed").map((e) => ({ t: e.t, s: l.seats }))).sort((a, b) => a.t - b.t);
      const path = sv("path", { fill: "none", stroke: css("--teal"), "stroke-width": 2.2 }, svg), over = sv("path", { fill: css("--coral"), opacity: 0.85 }, svg);
      const meter = (tc) => {
        let v = 0, d = `M${x0} ${MY(0)}`, od = "";
        for (const s of steps) { if (s.t > tc) break; d += ` H${X(s.t)} V${MY(v + s.s)}`; const nv = v + s.s; if (nv > cap) od += `M${X(s.t)} ${MY(cap)} V${MY(nv)} H${X(Math.min(tc, t1))} V${MY(cap)} Z`; v = nv; }
        d += ` H${X(Math.min(tc, t1))}`; path.setAttribute("d", d); over.setAttribute("d", od);
      };
      return (tc) => { for (const it of items) it.node.style.opacity = it.t <= tc ? 1 : 0.08; meter(tc); };
    }
    function cross(svg, x, y) { const p = sv("path", { d: `M${x - 4} ${y - 4} l8 8 M${x + 4} ${y - 4} l-8 8`, stroke: css("--grey"), "stroke-width": 2.2 }, svg); return p; }
    const scrub = $("#scrub"), set = (f) => { const tc = t0 + f * (t1 - t0); draws.forEach((d) => d(tc)); $("#tnow").textContent = `${((tc - t0) / 1000).toFixed(2)} s`; };
    scrub.addEventListener("input", () => set(scrub.value / 1000)); set(1);
    let raf = null; $("#play").addEventListener("click", () => {
      if (raf) { cancelAnimationFrame(raf); raf = null; $("#play").textContent = "Play"; return; }
      const start = performance.now(), dur = 7000; $("#play").textContent = "Pause";
      const step = (now) => { const f = Math.min(1, (now - start) / dur); scrub.value = f * 1000; set(f); if (f < 1) raf = requestAnimationFrame(step); else { raf = null; $("#play").textContent = "Play"; } };
      raf = requestAnimationFrame(step);
    });
    $("#race-note").textContent = "Numbers next to the old pattern's dots are the seats it saw as taken when it counted. Times are real wall-clock times from the run.";
  }

  // ---------- 03 timeout state machine
  {
    const P = R.paths, host = $("#sm"), W = 660, H = 440, svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "timeout handling flow" }); host.appendChild(svg);
    const defs = sv("defs", {}, svg), mk = sv("marker", { id: "ar", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs); sv("path", { d: "M0 0 L10 5 L0 10 z", fill: css("--ink2") }, mk);
    const box = (x, y, w, h, label, sub, tone) => { sv("rect", { x, y, width: w, height: h, rx: 8, fill: tone === "good" ? css("--teal-bg") : tone === "bad" ? css("--coral-bg") : css("--paper"), stroke: tone === "good" ? css("--teal") : tone === "bad" ? css("--coral") : css("--line") }, svg); txt(svg, x + w / 2, y + 21, label, { "text-anchor": "middle", "font-size": 14, "font-weight": 600, fill: css("--ink") }); if (sub) txt(svg, x + w / 2, y + 39, sub, { "text-anchor": "middle", "font-size": 12, fill: css("--ink2") }); };
    const arrow = (d) => sv("path", { d, fill: "none", stroke: css("--ink2"), "stroke-width": 1.5, "marker-end": "url(#ar)" }, svg);
    const unanswered = (P.auth_no_answer || 0) + (P.auth_timed_out || 0) + (P.auth_5xx || 0);
    box(220, 10, 180, 48, "auth, capture N", "order id = key + try number");
    box(10, 120, 170, 48, "approved (A)", "book the seats", "good");
    box(440, 120, 170, 48, "declined (C)", "release the hold");
    box(220, 120, 180, 52, "no answer / B / 5xx", `${unanswered} in the fault runs`, "bad");
    box(220, 232, 180, 48, "inquireByOrderid", `${(P.inquire_found_approved || 0) + (P.inquire_not_found || 0) + (P.inquire_found_declined || 0)} answered`);
    box(10, 340, 190, 52, "found, approved", `${P.inquire_found_approved || 0} kept, no second auth`, "good");
    box(215, 340, 190, 52, "no answer twice", `${P.inquire_no_answer || 0}: voidByOrderid, up to 3×`);
    box(420, 340, 190, 52, "29: Txn not found", `${P.inquire_not_found || 0} sent again`);
    arrow("M255 58 L120 118"); arrow("M365 58 L520 118"); arrow("M310 58 L310 118");
    arrow("M310 172 L310 230");
    arrow("M270 280 L120 338"); arrow("M310 280 L310 338"); arrow("M350 280 L500 338");
    arrow("M610 366 C 650 366, 650 34, 404 34");
    txt(svg, 606, 236, "new", { "font-size": 12, fill: css("--ink2"), "text-anchor": "end" }); txt(svg, 606, 251, "order id", { "font-size": 12, fill: css("--ink2"), "text-anchor": "end" });
    txt(svg, 10, 428, `${P.inquire_found_approved || 0} approvals were found by asking. A blind retry would have charged each of those customers again.`, { "font-size": 12.5, fill: css("--coral"), "font-weight": 600 });
    const rows = [["Auth sent, answer lost", P.auth_no_answer], ["“Timed out” (respstat B)", P.auth_timed_out], ["HTTP 5xx", P.auth_5xx], ["Inquiry found the approval", P.inquire_found_approved], ["Inquiry: “Txn not found”, sent again", P.inquire_not_found], ["Inquiry found a decline", P.inquire_found_declined], ["Inquiry unanswered", P.inquire_no_answer], ["Finished by the background job", P.reconciler_resumed]];
    $("#paths").innerHTML = `<table class="t">${rows.map(([a, b]) => `<tr><td>${a}</td><td class="num">${b || 0}</td></tr>`).join("")}</table>`;
    const T = D.tests || [];
    $("#tests").innerHTML = T.filter((t) => t.file === "checkout").map((t) => `<li class="${t.ok ? "" : "fail"}">${t.name}</li>`).join("");
  }

  // ---------- 04 MCP
  {
    const m = D.mcp, host = $("#mcp-diagram"), W = 1000, H = 230, svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "MCP layer" }); host.appendChild(svg);
    const defs = sv("defs", {}, svg), mk = sv("marker", { id: "ar2", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, defs); sv("path", { d: "M0 0 L10 5 L0 10 z", fill: css("--ink2") }, mk);
    const b = (x, y, w, h, t, s, tone) => { sv("rect", { x, y, width: w, height: h, rx: 8, fill: tone === "ink" ? css("--ink") : css("--paper"), stroke: tone === "ink" ? css("--ink") : css("--line") }, svg); txt(svg, x + 14, y + 22, t, { "font-size": 14, "font-weight": 600, fill: tone === "ink" ? css("--paper") : css("--ink") }); if (s) s.split("\n").forEach((line, i) => txt(svg, x + 14, y + 40 + i * 16, line, { "font-size": 11.5, fill: tone === "ink" ? "#C9D2DD" : css("--ink2"), class: "mono" })); };
    const ar = (d) => sv("path", { d, fill: "none", stroke: css("--ink2"), "stroke-width": 1.5, "marker-end": "url(#ar2)" }, svg);
    b(10, 10, 230, 58, "Email / review drafter (AI)", "read");
    b(10, 86, 230, 58, "Booking assistant (AI)", "read · propose");
    b(10, 162, 230, 58, "Call-center agent (person)", "read · pii · propose · approve");
    b(370, 40, 260, 150, "Reservations MCP server", "tools listed per caller\nscopes checked per call\npropose → approve, used once\nre-check at approval\naudit row per call", "ink");
    b(760, 30, 230, 70, "Old reservation API", "getAvail.php · getRes.php\nmoveRes.php");
    b(760, 130, 230, 70, "MongoDB service", "slots · bookings\ntransactions");
    ar("M240 39 L368 90"); ar("M240 115 L368 115"); ar("M240 191 L368 140");
    ar("M630 95 L758 65"); ar("M630 135 L758 165");
    txt(svg, 694, 60, "route per tool", { "font-size": 11, fill: css("--mute"), "text-anchor": "middle" });
    txt(svg, 694, 186, "parity-gated", { "font-size": 11, fill: css("--mute"), "text-anchor": "middle" });

    const all = ["search_availability", "get_booking", "propose_reschedule", "propose_refund", "approve_change"], who = Object.keys(m.tools);
    const ro = {}; for (const p of who) for (const t of m.tools[p]) ro[t.name] = t.readOnly ? "ro" : "wr";
    $("#mcp-matrix").innerHTML = `<table class="t"><tr><th>tool</th>${who.map((p) => `<th>${p}</th>`).join("")}</tr>${all.map((t) => `<tr><td><span class="pill ${ro[t]}">${t}</span></td>${who.map((p) => m.tools[p].some((x) => x.name === t) ? '<td class="y">●</td>' : '<td class="n">–</td>').join("")}</tr>`).join("")}</table>`;
    $("#mcp-matrix-note").textContent = "A tool that isn't listed for a caller doesn't exist for it: the MCP server answers “tool not found”. Read-only tools carry readOnlyHint; approve_change carries destructiveHint.";
    const pb = m.parityBefore, ex = pb.examples[0];
    $("#parity").innerHTML = `
      <div class="grid g2" style="gap:10px"><div><div class="stat bad">${pb.identical}/${pb.calls}</div><div class="stat-l">identical on the first run</div></div><div><div class="stat good">${m.parityAfter.identical}/${m.parityAfter.calls}</div><div class="stat-l">after aligning one rule</div></div></div>
      <p style="font-size:14.5px">All ${pb.differing} differences were the same field: <code>available</code>, only on departures with cancelled bookings. The old API counts cancelled seats as sold. (I planted that rule in the stand-in API to show the check catches this kind of thing; real old services have their own.)</p>
      <div class="urlbox">${ex.tool}(${ex.args.tour}, ${ex.args.date}) · ${ex.slot}<br>old API: available ${ex.diffs[0].legacy} · MongoDB: available ${ex.diffs[0].mongo}</div>
      <p style="font-size:14.5px;margin-bottom:0">Writes too: the same ${m.moveParity.moves} reschedules through both backends gave ${m.moveParity.outcomesMatch}/${m.moveParity.moves} identical outcomes (${Object.entries(m.moveParity.outcomes).map(([k, v]) => `${v} ${k}`).join(", ")}), and ${m.moveParity.bookingsMatch}/${m.moveParity.bookings} bookings and ${m.moveParity.slotsMatch}/${m.moveParity.slots} departures ended in the same state.</p>`;
    $("#checks").innerHTML = m.checks.map((c) => `<div class="check"><span class="${c.pass ? "ok" : "no"}">${c.pass ? "✓" : "✗"}</span><span>${c.name}</span><small>${String(c.detail ?? "").replace(/</g, "&lt;")}</small></div>`).join("");
    const o = m.overhead;
    $("#overhead").innerHTML = `<table class="t"><tr><th>get_booking, ${o.calls} calls</th><th style="text-align:right">p50</th><th style="text-align:right">p95</th></tr>${["mongo direct", "mongo via MCP", "old API direct", "old API via MCP"].map((k) => `<tr><td>${k}</td><td class="num">${o[k].p50} ms</td><td class="num">${o[k].p95} ms</td></tr>`).join("")}</table><p class="note">The layer adds about ${(o["mongo via MCP"].p50 - o["mongo direct"].p50).toFixed(1)} ms at the median: the protocol hop plus one audit insert. In-memory transport; stdio adds process I/O.</p>`;
    $("#audit").innerHTML = `<table class="t"><tr><th>principal</th><th>tool</th><th>backend</th><th>ok</th><th style="text-align:right">ms</th></tr>${m.audit.map((a) => `<tr><td>${a.principal}</td><td><code>${a.tool}</code></td><td>${a.backend}</td><td>${a.ok ? "yes" : a.code}</td><td class="num">${a.ms}</td></tr>`).join("")}</table>`;
  }

  // ---------- 05 phones
  {
    const w = D.webhooks, tf = w.twilioForm, tj = w.twilioJson, tx = w.telnyx;
    const telAgree = Object.values(tx.results).reduce((s, r) => s + r.sdkAgrees, 0), telN = Object.keys(tx.results).length * tx.casesEach;
    const stat = (v, l, cls = "good") => `<div class="card"><div class="stat ${cls}">${v}</div><div class="stat-l">${l}</div></div>`;
    $("#wh-stats").innerHTML = stat(`${fmt(tf.signatureIdentical)}/${fmt(tf.cases)}`, `Twilio signatures identical to the official <code>twilio</code> ${w.sdk.twilio} helper; all ${fmt(tf.bothRejectTampered)} tampered copies rejected by both`) +
      stat(`${fmt(tj.bothAccept)}/${fmt(tj.cases)}`, `JSON callbacks (<code>bodySHA256</code> in the URL) accepted by both; ${fmt(tj.bothRejectTamperedBody)} altered bodies rejected by both`) +
      stat(`${fmt(telAgree)}/${fmt(telN)}`, `Telnyx verdicts identical to <code>TelnyxWebhook</code> from <code>telnyx</code> ${w.sdk.telnyx}, across five cases; ${tx.usPerVerify} µs per Ed25519 check`);
    const p = w.proxy;
    $("#proxy").innerHTML = `<div class="tag bad">what the app sees</div><div class="urlbox bad">${p.appSees}</div>
      <div class="tag">what Twilio signed</div><div class="urlbox">${p.twilioSigned}</div>
      <div class="tag good">rebuilt from X-Forwarded-* (trusted proxy only)</div><div class="urlbox good">${p.rebuilt}</div>
      <p style="font-size:14.5px">Checked against the URL the app sees: <b>${p.naiveAccepts ? "accepted" : "rejected"}</b>. Against the rebuilt URL: <b>${p.rebuiltAccepts ? "accepted" : "rejected"}</b>. When that happens, the tempting fix is to switch validation off. Forwarded headers from an address that isn't the load balancer are ignored, so they can't be used to steer the check.</p>`;
    const names = { valid: "Signed by Telnyx's key", tamperedBody: "Body changed after signing", reserializedJson: "Same JSON, parsed and re-serialized", staleTimestamp: "Timestamp 301 s old", wrongKey: "Signed with a different key" };
    $("#telnyx").innerHTML = `<table class="t"><tr><th>case</th><th>should</th><th style="text-align:right">ours + SDK as expected</th></tr>${Object.entries(tx.results).map(([k, r]) => `<tr><td>${names[k]}</td><td>${k === "valid" ? "accept" : "reject"}</td><td class="num">${r.asExpectedBoth}/${tx.casesEach}</td></tr>`).join("")}</table><p class="note">The signature covers <code>timestamp|raw body</code>. Re-serialized JSON fails, so the handler must verify the raw bytes before parsing.</p>`;
    const c = w.callStatus;
    $("#calls").innerHTML = `<div class="grid g3" style="gap:10px">
      <div><div class="stat">${fmt(c.deliveries)}</div><div class="stat-l">callbacks for ${fmt(c.calls)} simulated calls, incl. ${c.duplicates} repeats and ${c.lateArrivals} late arrivals</div></div>
      <div><div class="stat bad">${c.lastWriteWins.wrongFinalStatus} · ${c.lastWriteWins.wrongDuration}</div><div class="stat-l">last write wins: calls with the wrong final status · wrong duration</div></div>
      <div><div class="stat good">${c.rankedMerge.wrongFinalStatus} · ${c.rankedMerge.wrongDuration}</div><div class="stat-l">ranked merge (never move a call backwards; terminal is final)</div></div></div>
      <p class="note">Twilio's support notes say a very short call's “completed” can show up before its “in-progress”. The repeat rate (6%) and timing are my assumptions, not measured traffic.</p>`;
  }

  // ---------- 07 run
  {
    const T = D.tests || [];
    $("#measured").innerHTML = [
      `${T.filter((t) => t.ok).length}/${T.length} tests pass (node:test, real MongoDB ${M.mongo} replica set)`,
      `Chaos bench: ${M.seeds} seeds × ${M.intentsPerRun} checkouts × 2 flows × 2 scenarios, counted from the database and the gateway's own ledger`,
      `MCP: ${D.mcp.parityBefore.calls} read calls compared per parity run, ${D.mcp.moveParity.moves} reschedules, ${D.mcp.checks.length} guardrail checks, SDK ${D.mcp.sdk}`,
      `Webhooks: ${fmt(D.webhooks.twilioForm.cases)} Twilio, ${D.webhooks.twilioJson.cases} Twilio JSON and ${fmt(Object.keys(D.webhooks.telnyx.results).length * D.webhooks.telnyx.casesEach)} Telnyx cases against the vendors' SDKs`,
    ].map((s) => `<li>${s}</li>`).join("");
    $("#foot").textContent = `Data generated ${M.when.slice(0, 16).replace("T", " ")} UTC.`;
  }
  document.body.dataset.ready = "1";
})();
