import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("MCP stdio exposes the notebook read and write tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ownsoft-mcp-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./notebook-mcp.mjs", import.meta.url))], {
    env: { ...process.env, AI_NOTEBOOK_DATA_DIR: dir }, stdio: ["pipe", "pipe", "pipe"]
  });
  try {
    const rows = [];
    let pending = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const at = pending.indexOf("\n");
        if (at < 0) break;
        rows.push(JSON.parse(pending.slice(0, at)));
        pending = pending.slice(at + 1);
      }
    });
    const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    send(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    send(2, "tools/list", {});
    send(3, "tools/call", { name: "search_library", arguments: { query: "工作笔记" } });
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`)));
    });
    assert.equal(rows[0].result.serverInfo.name, "ownsoft");
    assert(rows[1].result.tools.some((tool) => tool.name === "import_markdown"));
    assert(rows[1].result.tools.some((tool) => tool.name === "move_message_to_annotation"));
    assert(rows[1].result.tools.some((tool) => tool.name === "undo_message_annotation"));
    assert.equal(JSON.parse(rows[2].result.content[0].text)[0].title, "我的工作笔记");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
