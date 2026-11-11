// Usage: node scripts/call.mjs '<json array of {name, arguments}>'  — calls MCP tools sequentially, prints results.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const calls = JSON.parse(process.argv[2]);
const c = new Client({ name: "call", version: "0" });
c.setNotificationHandler(LoggingMessageNotificationSchema, (n) => console.log("  [live log]", n.params.data));
await c.connect(new StdioClientTransport({ command: "node", args: ["build/index.js"], stderr: "ignore" }));
for (const call of calls) {
  const r = await c.callTool(call, undefined, { timeout: 200000 });
  console.log(r.isError ? "ERROR" : "OK", call.name, r.content[0].text.slice(0, 3000));
}
await c.close();
