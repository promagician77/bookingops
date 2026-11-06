# Checkout reliability lab

What happens to a booking when the payment answer never comes back, measured. Two checkout flows run
the same booking rush on a real MongoDB replica set against a CardPointe-shaped test gateway that
loses answers, times out and returns 5xx. Also here: an MCP layer in front of an old reservation API,
and Twilio/Telnyx webhook checks cross-checked against the vendors' SDKs.

The static page in `site/` shows the results. Every number on it comes from `results/*.json`.

## Results (5 seeds × 220 customers per flow and scenario, run 2026-11-06)

| | No faults: old | Reworked | With faults: old | Reworked |
|---|---:|---:|---:|---:|
| Seats sold beyond capacity | 35 | 0 | 22 | 0 |
| Customers charged twice | 0 | 0 | 11 | 0 |
| Charged, no booking | 0 | 0 | 10 | 0 |
| Refunds owed | $0 | $0 | $6,378 | $0 |
| Bookings made | 479 | 466 | 479 | 466 |
| Median time to confirmation | 46 ms | 78 ms | 47 ms | 79 ms |

With faults, the reworked flow found 26 approvals by `inquireByOrderid` after a lost answer; a blind
retry would have charged each of those customers a second time. 20/20 tests pass.

## The reworked checkout (`src/robust.js`)

1. One idempotency key per checkout; one worker per key at a time (a lease with an owner token).
2. Seats held with one conditional update: `booked + held + party <= capacity`. The key is recorded
   on the departure, so a retried hold or release is a no-op.
3. Auth only (`capture: "N"`), with a unique order id per try. If the auth gets no answer, a 5xx or
   respstat `B`, call `inquireByOrderid` before sending anything again. `29 Txn not found` means it
   never happened, so send a new one. No answer to the inquiry either: `voidByOrderid`, up to 3 tries.
   This follows CardPointe's "Handling Timed-out Transactions" guide.
4. Seats move from held to booked in one idempotent update; the booking row and the attempt state
   change in one transaction that doesn't touch the busy departure document.
5. Capture after the customer is confirmed. A background job resumes stuck checkouts, captures
   anything uncaptured and sweeps orphaned holds.
6. When the seats are only taken by other customers' holds, the customer is told to wait, not
   "sold out".

`src/legacy.js` is the comparison: count seats, sale (auth + capture), insert. It is a common
pattern, not anyone's real code.

## MCP layer (`src/mcp/`)

- `server.js`: official `@modelcontextprotocol/sdk` server. Tools are registered per caller
  (`email-drafter`: read; `booking-assistant`: read + propose; `call-center-agent`: + pii + approve).
  Writes are propose → approve, re-checked at approval, one use per approval. Every call is audited.
- `adapters.js`: the same tool contract over the old API (`legacy-api.js`, PHP-style endpoints, US
  dates, 12-hour local times) and over MongoDB. `routes` picks the backend per tool.
- `bench/mcp.js`: parity of every read call between both backends, the same 60 reschedules through
  both, the guardrail checks and the latency overhead, all through a real MCP client.
- `mcp/stdio.js`: run it for an MCP client:
  `PRINCIPAL=booking-assistant MONGO_URL=... node mcp/stdio.js`

## Webhooks (`src/webhooks.js`)

- Twilio `X-Twilio-Signature` (HMAC-SHA1 over URL + sorted params; JSON bodies via `bodySHA256`),
  compared with `twilio.getExpectedTwilioSignature` / `validateRequest` / `validateRequestWithBody`.
- The public URL behind a TLS-terminating load balancer, trusting `X-Forwarded-*` only from known proxies.
- Telnyx Ed25519 over `timestamp|raw body`, 300 s window, compared with `TelnyxWebhook` from `telnyx`.
- Call status merge that ignores repeats and never moves a call backwards.

## Run

Node 20+ and a MongoDB replica set (transactions need one):

```
npm install
mongod --dbpath ./.mdb --replSet rs0 --port 27017 &
mongosh --eval 'rs.initiate()'
npm test               # 20 tests
npm run test:report    # results/tests.json for the site
npm run bench:chaos    # results/chaos.json (~3-4 min)
npm run bench:mcp      # results/mcp.json
npm run bench:webhooks # results/webhooks.json
npm run site           # site/data/site.json
```

`MONGO_URL` overrides the default `mongodb://127.0.0.1:27017/?replicaSet=rs0`.

## Deploy the page

`vercel.json` serves `site/` as static files with `X-Robots-Tag: noindex, nofollow`. No build step.

## Measured vs not

Measured: everything in `results/`, on MongoDB 8.3.7 (single-node replica set, 2 vCPU container),
Node 22, twilio 6.3.0, telnyx 7.30.0, @modelcontextprotocol/sdk 1.32.x.

Not measured, or not real:
- The gateway is a stand-in with CardPointe's REST paths and response fields, not CardPointe.
- Fault rates are assumptions. Latency on Atlas will differ; the counts of oversold seats and
  double charges come from the database and the gateway's ledger, not from timing.
- No language model was called; the MCP tools were driven by an MCP client.
- Twilio and Telnyx were checked offline against their SDKs; the call-status stream is simulated.
