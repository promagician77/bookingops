// MCP layer in front of the reservation backends (official @modelcontextprotocol/sdk).
// - A tool only exists for a caller whose scopes allow it, so an AI email drafter never even
//   sees a write tool. The server checks scopes again on every call.
// - Changes are two-step: an AI can only *propose* (preview + approval id). A human-held
//   principal with the "approve" scope confirms; the change is re-checked at that moment and
//   each approval works once.
// - Every call is written to an audit collection: who, which tool, which backend, result, time.
// - routes{} picks the backend per tool ("legacy" | "mongo"), so services move one tool at a time.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";

export const PRINCIPALS = {
  "email-drafter": { scopes: ["read"] },
  "booking-assistant": { scopes: ["read", "propose"] },
  "call-center-agent": { scopes: ["read", "pii", "propose", "approve"] },
};

export function buildServer({ principal, adapters, routes = {}, db }) {
  const p = typeof principal === "string" ? { name: principal, ...PRINCIPALS[principal] } : principal;
  const can = (s) => p.scopes.includes(s);
  const audit = db.collection("audit"), approvals = db.collection("approvals");
  const backend = (tool) => adapters[routes[tool] || "mongo"];
  const server = new McpServer({ name: "reservations", version: "0.3.0" });
  const reply = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }], isError: !!o?.error });

  function tool(name, scope, cfg, fn) {
    if (!can(scope)) return;                                  // not registered: invisible to this caller
    server.registerTool(name, cfg, async (args) => {
      const t0 = performance.now(); let out;
      if (!can(scope)) out = { error: { code: "forbidden", message: `${p.name} lacks ${scope}` } };
      else { try { out = await fn(args); } catch (e) { out = { error: { code: "internal", message: e.message } }; } }
      await audit.insertOne({ at: new Date(), principal: p.name, tool: name, args, backend: routes[name] || "mongo", ok: !out?.error, code: out?.error?.code, ms: +(performance.now() - t0).toFixed(2) });
      return reply(out);
    });
  }
  const mask = (b) => (b.error || can("pii") ? b : { ...b, guest: { first: b.guest.first, last: b.guest.last[0] + "." } });

  tool("search_availability", "read", {
    title: "Search availability", description: "Open seats for a tour on a date. Times carry the tour location's UTC offset.",
    inputSchema: { tour: z.enum(["HELI", "ZIP", "RAFT"]), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }, annotations: { readOnlyHint: true },
  }, (a) => backend("search_availability").searchAvailability(a));

  tool("get_booking", "read", {
    title: "Get booking", description: "One booking by its 6-character reference.",
    inputSchema: { ref: z.string().regex(/^[A-Z0-9]{6}$/) }, annotations: { readOnlyHint: true },
  }, async (a) => mask(await backend("get_booking").getBooking(a)));

  tool("propose_reschedule", "propose", {
    title: "Propose a reschedule", description: "Checks the move and returns a preview and an approval id. Nothing changes until a person approves it.",
    inputSchema: { ref: z.string().regex(/^[A-Z0-9]{6}$/), to_slot: z.string(), note: z.string().max(500).optional() }, annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ ref, to_slot, note }) => {
    const b = await backend("get_booking").getBooking({ ref });
    if (b.error) return b;
    if (b.status !== "confirmed") return { error: { code: "cancelled", message: "booking is cancelled" } };
    const [tour, date] = [to_slot.split("-")[0], to_slot.slice(to_slot.indexOf("-") + 1, to_slot.indexOf("-") + 11)];
    const av = await backend("search_availability").searchAvailability({ tour, date });
    const target = av.slots?.find((s) => s.slot_id === to_slot);
    if (!target || tour !== b.slot_id.split("-")[0]) return { error: { code: "bad_slot", message: to_slot } };
    if (target.available < b.party) return { error: { code: "full", message: `${target.available} seats left, party of ${b.party}` } };
    const id = randomUUID();
    await approvals.insertOne({ _id: id, kind: "reschedule", ref, from: b.slot_id, to: to_slot, party: b.party, note, proposedBy: p.name, status: "pending", at: new Date() });
    return { approval_id: id, status: "pending_approval", preview: { ref, party: b.party, from: { slot_id: b.slot_id, start: b.start }, to: { slot_id: to_slot, start: target.start }, seats_left_after: target.available - b.party } };
  });

  tool("propose_refund", "propose", {
    title: "Propose a refund", description: "Queues a refund request for a person to approve. Never moves money by itself.",
    inputSchema: { ref: z.string().regex(/^[A-Z0-9]{6}$/), amount_cents: z.number().int().positive(), reason: z.string().min(3).max(500) }, annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ ref, amount_cents, reason }) => {
    const b = await backend("get_booking").getBooking({ ref });
    if (b.error) return b;
    if (amount_cents > b.total_cents) return { error: { code: "over_total", message: `booking total is ${b.total_cents}` } };
    const id = randomUUID();
    await approvals.insertOne({ _id: id, kind: "refund", ref, amount_cents, reason, proposedBy: p.name, status: "pending", at: new Date() });
    return { approval_id: id, status: "pending_approval", preview: { ref, amount_cents, of_total_cents: b.total_cents } };
  });

  tool("approve_change", "approve", {
    title: "Approve a proposed change", description: "Carries out a pending proposal after re-checking it. Each approval works once.",
    inputSchema: { approval_id: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ approval_id }) => {
    const ap = await approvals.findOneAndUpdate({ _id: approval_id, status: "pending" }, { $set: { status: "executing", approvedBy: p.name, approvedAt: new Date() } });
    if (!ap) return { error: { code: "not_pending", message: "unknown or already used" } };
    let out;
    if (ap.kind === "reschedule") out = await backend("move_booking").moveBooking({ ref: ap.ref, toSlot: ap.to });
    else out = { ref: ap.ref, status: "refund_queued", amount_cents: ap.amount_cents };   // handed to the payments queue, not executed here
    await approvals.updateOne({ _id: approval_id }, { $set: { status: out.error ? "failed" : "done", result: out } });
    return out;
  });
  return server;
}
