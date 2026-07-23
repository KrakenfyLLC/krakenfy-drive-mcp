import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../src/index.js", import.meta.url).pathname],
  env: { ...process.env, GDRIVE_CREDS_DIR: "/tmp/krakenfy-drive-mcp-test-missing-creds" },
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
assert.equal(tools.length, 17);
assert(tools.some((item) => item.name === "drive_list_folder"));
assert(tools.some((item) => item.name === "drive_get_folder_tree"));
assert(tools.some((item) => item.name === "drive_create_workspace"));
assert(tools.some((item) => item.name === "drive_trash_file"));
assert(tools.some((item) => item.name === "drive_share_file"));
assert(tools.some((item) => item.name === "sheets_update"));
assert(tools.some((item) => item.name === "sheets_append_rows"));

const unbounded = await client.callTool({ name: "sheets_read", arguments: { spreadsheetId: "sheet-id", ranges: ["Sheet1!A:Z"] } });
assert.equal(unbounded.isError, true);
assert.match(unbounded.content[0].text, /bounded rectangle/);

const oversized = await client.callTool({ name: "sheets_read", arguments: { spreadsheetId: "sheet-id", ranges: ["A1:ZZ100000"] } });
assert.equal(oversized.isError, true);
assert.match(oversized.content[0].text, /cells per range/);

const bounded = await client.callTool({ name: "sheets_read", arguments: { spreadsheetId: "sheet-id", ranges: ["'Q3 Report'!A1:F200"] } });
assert.equal(bounded.isError, true);
assert.match(bounded.content[0].text, /No OAuth token found/); // range accepted; fails later at auth in this creds-free environment

await client.close();
console.log("MCP smoke test passed: 17 tools exposed, unbounded Sheets reads rejected");
