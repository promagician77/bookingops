#!/usr/bin/env node
// Run the reservations MCP server over stdio for an MCP client (Claude Desktop, an agent, etc).
//   MONGO_URL=... PRINCIPAL=booking-assistant LEGACY_URL=http://old-host ROUTES='{"get_booking":"legacy"}' node mcp/stdio.js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect } from "../src/db.js";
import { buildServer, PRINCIPALS } from "../src/mcp/server.js";
import { legacyAdapter, mongoAdapter } from "../src/mcp/adapters.js";

const principal = process.env.PRINCIPAL || "email-drafter";
if (!PRINCIPALS[principal]) { console.error(`unknown PRINCIPAL ${principal}; one of ${Object.keys(PRINCIPALS).join(", ")}`); process.exit(2); }
const { client, db } = await connect(process.env.MONGO_URL, process.env.MONGO_DB || "reservations");
const adapters = { mongo: mongoAdapter({ client, db }) };
if (process.env.LEGACY_URL) adapters.legacy = legacyAdapter(process.env.LEGACY_URL);
const routes = JSON.parse(process.env.ROUTES || "{}");
const server = buildServer({ principal, adapters, routes, db });
await server.connect(new StdioServerTransport());
console.error(`reservations MCP up as ${principal}; routes ${JSON.stringify(routes)}`);
