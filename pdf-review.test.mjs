import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync, zipSync } from "fflate";
import { decodeReview, encodeReview } from "./pdf-review.mjs";

test("an aipdf round trip preserves the original PDF bytes and comment coordinates", () => {
  const pdf = Buffer.from("%PDF-1.4\nexample\n%%EOF");
  const comment = { id: "test-1", page: 2, rects: [[.2, .3, .6, .34]], title: "批注",
    text: "这一句需要补充出处。", quote: "原句", priority: "P1" };
  const bytes = encodeReview(pdf, "原稿.pdf", [comment]);
  const saved = decodeReview(bytes);
  assert.equal(saved.name, "原稿.pdf");
  assert.deepEqual(saved.comments, [comment]);
  assert.deepEqual(Buffer.from(saved.pdf), pdf);
  const archive = unzipSync(bytes);
  archive["document.pdf"] = Buffer.from("%PDF-1.4\ndifferent\n%%EOF");
  assert.throws(() => decodeReview(zipSync(archive)), /批注版本不匹配/);
});

test("comment conversations travel with the PDF review", () => {
  const pdf = Buffer.from("%PDF-1.4\nexample\n%%EOF");
  const comment = { id: "test-1", page: 1, rects: [], title: "批注", text: "建议扩写。", quote: "原句", priority: "",
    turns: [{ id: "turn-1", question: "如何扩写？", answer: "加一个例子。", source: { provider: "claude", model: "sonnet", effort: "high" } }] };
  assert.deepEqual(decodeReview(encodeReview(pdf, "原稿.pdf", [comment])).comments, [comment]);
  assert.throws(() => encodeReview(pdf, "原稿.pdf", [{ ...comment, turns: null }]), /批注对话记录无效/);
});
