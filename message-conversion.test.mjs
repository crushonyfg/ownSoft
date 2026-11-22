import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotebookStore } from "./store.mjs";

test("a chat annotation can restore the original message", () => {
  const dir = mkdtempSync(join(tmpdir(), "ownsoft-undo-"));
  const store = new NotebookStore(join(dir, "notebook.sqlite"));
  try {
    const chat = store.saveReply(null, "问题", "完整回答", undefined);
    const question = chat.blocks.find((block) => block.kind === "question");
    const reply = chat.blocks.find((block) => block.kind === "reply");
    const moved = store.change({ type: "message-to-annotation", ids: [reply.id],
      anchor: { blockId: question.id, start: 0, quote: "问题" } }, chat.id);
    assert.equal(moved.blocks.find((block) => block.id === reply.id).removed, true);
    assert.equal(moved.notes[0].sourceMessageId, reply.id);
    const restored = store.change({ type: "undo-message-to-annotation", id: moved.notes[0].id }, chat.id);
    assert.equal(restored.blocks.find((block) => block.id === reply.id).text, "完整回答");
    assert.equal(restored.notes.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an older note-block annotation without source metadata can be restored", () => {
  const dir = mkdtempSync(join(tmpdir(), "ownsoft-legacy-undo-"));
  const store = new NotebookStore(join(dir, "notebook.sqlite"));
  try {
    const chat = store.saveReply(null, "问题", "回答", undefined);
    const question = chat.blocks.find((block) => block.kind === "question");
    const added = store.change({ type: "add-shared-block", text: "原来的笔记块" }, chat.id);
    const paragraph = added.blocks.find((block) => block.kind === "paragraph" && block.text === "原来的笔记块");
    const moved = store.change({ type: "message-to-annotation", ids: [paragraph.id],
      anchor: { blockId: question.id, start: 0, quote: "问题" } }, chat.id);
    const legacy = store.read(chat.id);
    delete legacy.notes[0].sourceMessageId;
    delete legacy.blocks.find((block) => block.id === paragraph.id).conversionBackup;
    store.write(legacy);
    const restored = store.change({ type: "undo-message-to-annotation", id: moved.notes[0].id }, chat.id);
    assert.equal(restored.blocks.find((block) => block.id === paragraph.id).text, "原来的笔记块");
    assert.equal(restored.blocks.find((block) => block.id === paragraph.id).removed, false);
    assert.equal(restored.notes.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a PDF chat message can hang on selected PDF text and restore on undo", () => {
  const dir = mkdtempSync(join(tmpdir(), "ownsoft-pdf-move-"));
  const store = new NotebookStore(join(dir, "notebook.sqlite"));
  try {
    const hash = "b".repeat(64);
    store.savePdfReview(hash, "paper.pdf", { comments: [], chat: [] });
    const chatId = store.openChildChat({ kind: "pdf-chat", hash });
    const chat = store.saveReply(null, "概述", "PDF 分析结果", undefined, [], chatId);
    const reply = chat.blocks.find((block) => block.kind === "reply");
    const result = store.moveMessageToPdfAnnotation(chatId, [reply.id], hash,
      { page: 2, quote: "PDF 原文", rects: [[0.1, 0.2, 0.5, 0.23]] });
    assert.equal(store.read(chatId).blocks.find((block) => block.id === reply.id).removed, true);
    assert.equal(store.pdfReview(hash).comments[0].quote, "PDF 原文");
    assert.deepEqual(store.pdfReview(hash).comments[0].rects, [[0.1, 0.2, 0.5, 0.23]]);
    store.undoPdfMessageConversion(hash, result.comment.id);
    assert.equal(store.pdfReview(hash).comments.length, 0);
    assert.equal(store.read(chatId).blocks.find((block) => block.id === reply.id).text, "PDF 分析结果");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
