import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mdCommentOrigin, mdDocumentOrigin, mdSelectionOrigin, paragraphAround, shiftAnnotations } from "./md-document.mjs";
import { commentContext } from "./notebook.mjs";
import { NotebookStore } from "./store.mjs";

const note = (id, text, quote, extra = {}) => ({ id, start: text.indexOf(quote), quote, title: "批注", text: `关于${quote}`, ...extra });

test("annotations follow edits before them and are found again when their passage moves", () => {
  const before = "# 标题\n\n第一段有关键句。\n\n第二段讲公式 \\(x^2\\)。";
  const comments = [note("a", before, "关键句"), note("b", before, "\\(x^2\\)"), note("c", before, "标题")];
  const inserted = "# 标题\n\n新加的一段。\n\n第一段有关键句。\n\n第二段讲公式 \\(x^2\\)。";
  const moved = shiftAnnotations(before, inserted, comments);
  for (const item of moved) assert.equal(inserted.slice(item.start, item.start + item.quote.length), item.quote);
  const rewritten = inserted.replace("关键句", "别的话");
  const after = shiftAnnotations(inserted, rewritten, moved);
  assert.equal(after.find((item) => item.id === "a").lost, true);
  assert.equal(after.find((item) => item.id === "b").lost, undefined);
  const restored = shiftAnnotations(rewritten, inserted, after);
  assert.equal(restored.find((item) => item.id === "a").lost, undefined);
});

test("questions about a document carry the right passage and the document text", () => {
  const text = "前言。\n\n这一段有 \\(E=mc^2\\) 和说明。\n\n结尾。";
  assert.equal(paragraphAround(text, text.indexOf("E=mc")), "这一段有 \\(E=mc^2\\) 和说明。");
  const selection = commentContext(mdSelectionOrigin("物理.md", text, text.indexOf("说明"), "说明"));
  assert.match(selection, /Markdown 文档「物理.md」中选中的一段/);
  assert.match(selection, /所在段落：\n这一段有/);
  assert.match(selection, /文档原文供参考：\n前言/);
  const comment = note("x", text, "E=mc^2");
  assert.match(commentContext(mdCommentOrigin("物理.md", text, comment)), /批注：\n关于E=mc\^2/);
  const whole = commentContext(mdDocumentOrigin("物理.md", text, [comment, { ...comment, id: "y", lost: true }]));
  assert.match(whole, /已有批注：\n1\. 「E=mc\^2」：关于E=mc\^2$/);
});

test("documents are stored with their annotations and conversation, and anchors are checked on save", () => {
  const store = new NotebookStore(":memory:");
  try {
    const id = randomUUID();
    const text = "# 笔记\n\n要点在这里。";
    store.saveMdDocument(id, { name: "笔记.md", path: "D:\\notes\\笔记.md", text,
      comments: [note("a", text, "要点")], chat: [{ id: "t1", question: "总结", answer: "很短" }], fileHash: "abc" });
    const saved = store.mdDocument(id);
    assert.equal(saved.comments[0].start, text.indexOf("要点"));
    assert.equal(saved.chat.length, 1);
    assert.equal(store.mdDocumentByPath("d:\\NOTES\\笔记.md").id, id);
    const edited = store.saveMdDocument(id, { ...saved, text: "# 笔记\n\n改写了。", unsynced: true });
    assert.equal(edited.comments[0].lost, true);
    assert.equal(edited.unsynced, true);
    assert.deepEqual(store.mdDocuments().map((item) => [item.name, item.comments, item.chat, item.unsynced]), [["笔记.md", 1, 1, true]]);
    assert.throws(() => store.saveMdDocument(id, { ...saved, path: "relative.md" }), /路径无效/);
    assert.throws(() => store.saveMdDocument("../x", saved), /无效/);
    store.removeMdDocument(id);
    assert.equal(store.mdDocument(id), null);
  } finally {
    store.close();
  }
});
