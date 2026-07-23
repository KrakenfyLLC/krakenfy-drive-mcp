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
await client.close();
console.log("MCP smoke test passed: 17 tools exposed");
