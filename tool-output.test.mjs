import assert from "node:assert/strict";
import { test } from "node:test";
import { toolOutput } from "./tool-output.mjs";

test("tool results keep readable text without binary payloads or unbounded output", () => {
  const output = toolOutput({ content: [
    { type: "text", text: "第 3 页：方法与实验。" },
    { type: "image", data: "secret-base64-payload" }
  ], result: { stdout: "\u001b[31m表 2：准确率 91%\u001b[0m" } });
  assert.match(output, /第 3 页：方法与实验/);
  assert.match(output, /表 2：准确率 91%/);
  assert.doesNotMatch(output, /secret-base64-payload|\u001b/);
  assert.match(toolOutput("x".repeat(100), 20), /^x{20}\n…（工具结果已截断）$/);
  assert.equal(toolOutput("a".repeat(5000)).length, 5000);
  assert.match(toolOutput({ results: [{ title: "论文摘要", url: "https://example.org/paper",
    snippet: "样本量 214" }] }), /论文摘要\nhttps:\/\/example\.org\/paper\n样本量 214/);
});
