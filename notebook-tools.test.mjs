import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotebookTools } from "./notebook-tools.mjs";

test("model tools search and trace chat, save Markdown, and edit annotations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ownsoft-tools-"));
  const tools = new NotebookTools(dir);
  try {
    const chat = tools.store.saveReply(null, "为什么选择样本 A？", "因为第 3 页的证据。", undefined,
      [], undefined, [{ id: "read-1", title: "Read", detail: "第 3 页", result: "样本 A 的证据", status: "done" }]);
    const question = chat.blocks.find((block) => block.kind === "question");
    const answer = chat.blocks.find((block) => block.kind === "reply");
    assert.equal(tools.resolveMessage({ messageId: answer.id }).notebookId, chat.id);
    assert.equal(tools.list({ query: "样本 A" })[0].id, chat.id);
    assert.match(tools.readChat({ notebookId: chat.id }).messages.find((item) => item.kind === "question").text, /为什么选择/);
    assert.match(tools.readMessage({ notebookId: chat.id, messageId: answer.id }).text, /样本 A 的证据/);
    const added = tools.addNoteBlock({ notebookId: chat.id, text: "[来源](ownsoft://chat/" + chat.id + ")", afterId: question.id });
    assert.equal(tools.store.read(chat.id).blocks.find((block) => block.id === added.blockId).kind, "paragraph");
    const note = tools.annotate({ kind: "chat", notebookId: chat.id, blockId: answer.id,
      quote: "第 3 页", text: "核实这一页" });
    tools.editAnnotation({ kind: "chat", notebookId: chat.id, annotationId: note.id, text: "已核实" });
    assert.equal(tools.store.read(chat.id).notes.at(-1).text, "已核实");
    const md = tools.saveMarkdown({ name: "分析.md", text: "# 分析\n\n证据来自第 3 页。", notebookId: chat.id });
    assert.equal(tools.store.read(chat.id).blocks.at(-1).mdId, md.id);
    assert.match(tools.readMarkdown({ mdId: md.id }).text, /证据来自/);
    assert.equal(tools.readChat({ notebookId: chat.id }).messages.at(-1).mdId, md.id);
    assert.equal(tools.insertMarkdownBlock({ notebookId: chat.id, mdId: md.id }).mdId, md.id);
    const mdNote = tools.annotate({ kind: "md", mdId: md.id, quote: "证据来自第 3 页", text: "复核图表" });
    tools.editAnnotation({ kind: "md", mdId: md.id, annotationId: mdNote.id, text: "图表已复核" });
    assert.equal(tools.store.mdDocument(md.id).comments[0].text, "图表已复核");
    const path = join(dir, "agent-output.md");
    writeFileSync(path, "# Agent 输出\n\n已完成。", "utf8");
    const imported = tools.importMarkdown({ path, notebookId: chat.id });
    assert.match(tools.readMarkdown({ mdId: imported.id }).text, /已完成/);
    const hash = "a".repeat(64);
    tools.store.savePdfReview(hash, "paper.pdf", { comments: [], chat: [] });
    const pdfNote = tools.annotate({ kind: "pdf", hash, page: 3, quote: "样本 A", text: "核实样本" });
    assert.equal(tools.readPdfReview({ hash }).annotations[0].id, pdfNote.id);
  } finally {
    tools.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
