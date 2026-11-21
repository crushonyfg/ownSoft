import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, splitMarkdown, textOffsets } from "./markdown.mjs";

test("Markdown keeps headings, adjacent Chinese emphasis and multi-paragraph lists", () => {
  const source = "## **标题**\n\n**结论：**继续。\n\n- 第一项\n\n- 第二项\n\n| 名称 | 值 |\n| --- | --- |\n| a | b |";
  const blocks = parseMarkdown(source).children;
  assert.deepEqual(blocks.map((item) => item.type), ["heading", "paragraph", "list", "table"]);
  assert.equal(blocks[0].children[0].type, "strong");
  assert.equal(blocks[1].children[0].type, "strong");
  assert.equal(blocks[2].children.length, 2);
  assert.equal(splitMarkdown(source)[2], "- 第一项\n\n- 第二项");
  const references = "使用 [链接][id]。\n\n[id]: https://example.com";
  assert.deepEqual(splitMarkdown(references), [references]);
});

test("visible entities and escaped characters map to their complete original Markdown spans", () => {
  const raw = "甲 \\* &amp; &#x1F600; 乙";
  const text = parseMarkdown(raw).children[0].children[0];
  assert.equal(text.value, "甲 * & 😀 乙");
  const map = textOffsets(raw, text.value, 0, raw.length);
  const sourceAt = (unit) => raw.slice(map[unit * 2], map[unit * 2 + 1]);
  assert.equal(sourceAt(2), "\\*");
  assert.equal(sourceAt(4), "&amp;");
  assert.equal(sourceAt(6), "&#x1F600;");
  assert.equal(sourceAt(7), "&#x1F600;");
  assert.equal(sourceAt(9), "乙");
});
