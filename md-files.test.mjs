import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookStore } from "./store.mjs";
import { MarkdownFiles } from "./md-files.mjs";
import { anchoredText, toggleTextMark, moveAnchors } from "./text-anchors.mjs";
import { mergeText, textEdits } from "./text-edits.mjs";

async function fixture(text = "第一段。\n\n中间的原文。\n\n最后一段。\n", options) {
  const folder = await mkdtemp(join(tmpdir(), "ownsoft-md-sync-")), path = join(folder, "paper.md");
  await writeFile(path, text);
  const store = new NotebookStore(":memory:"), files = new MarkdownFiles(store, options), doc = await files.import(path);
  return { path, store, files, doc, close() { files.close(); store.close(); } };
}

test("text edits reconstruct files and merge independent changes without conflict markers", () => {
  for (const [a, b] of [["", "添加"], ["删除", ""], ["a\r\nb\r\n", "a\r\n新增\r\nbb\r\n"], ["a\nb\nc\nd\n", "A\nb\nc\nD\n"]]) {
    let actual = a;
    for (const e of textEdits(a, b).reverse()) actual = actual.slice(0, e.start) + e.text + actual.slice(e.end);
    assert.equal(actual, b);
  }
  assert.deepEqual(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"), { clean: true, text: "A\nb\nC\n" });
  assert.equal(mergeText("原段落", "应用改写", "agent 改写").clean, false);
  assert.equal(mergeText("Alpha paragraph", "LocalAlpha paragraph", "AgentAlpha paragraph").clean, false);
});

test("repeated original text is not silently reattached to a different paragraph", () => {
  const before = "第一处：共同表达。\n\n第二处：共同表达。";
  const anchor = anchoredText(before, before.indexOf("共同表达"), "共同表达");
  const [lost] = moveAnchors(before, "第二处：共同表达。", [anchor]);
  assert.equal(lost.lost, true);
  assert.equal(lost.quote, "共同表达");
  const text = "开头\n\n原文段落\n\n结尾";
  const [moved] = moveAnchors(text, "新增开头\n\n开头\n\n原文段落\n\n结尾", [anchoredText(text, text.indexOf("原文"), "原文")]);
  assert.equal(moved.lost, undefined);
  assert.equal(moved.start, "新增开头\n\n开头\n\n".length);
});

test("external edits reload clean drafts and move annotations, highlights and selection-chat anchors", async () => {
  const f = await fixture();
  try {
    const start = f.doc.text.indexOf("中间");
    const marks = [];
    toggleTextMark(f.doc.text, marks, { start, quote: "中间" }, "underline");
    let doc = await f.files.save(f.doc.id, { ...f.doc, marks,
      comments: [{ id: "n", ...anchoredText(f.doc.text, start, "中间"), text: "解释", title: "意见" }] });
    const chatId = f.store.openChildChat({ kind: "md-selection", mdId: doc.id, selection: { id: "s", start, quote: "中间" } });
    await writeFile(f.path, `新增一段。\n\n${doc.text}`);
    doc = await f.files.open(doc.id);
    assert.equal(doc.unsynced, false);
    assert.equal(doc.comments[0].start, start + "新增一段。\n\n".length);
    assert.equal(doc.marks[0].start, doc.comments[0].start);
    assert.equal(f.store.read(chatId).parent.selection.start, doc.comments[0].start);
    await writeFile(f.path, doc.text.replace("中间的原文", "已经改写"));
    doc = await f.files.open(doc.id);
    assert.equal(doc.comments[0].lost, true);
    assert.equal(doc.marks[0].lost, true);
    assert.equal(f.store.read(chatId).parent.selection.lost, true);
  } finally { f.close(); }
});

test("application and agent changes to different passages merge before writing", async () => {
  const f = await fixture();
  try {
    const draft = await f.files.save(f.doc.id, { text: f.doc.text.replace("第一段", "应用改第一段"), base: f.doc });
    await writeFile(f.path, f.doc.text.replace("最后一段", "agent 改最后一段"));
    const saved = await f.files.save(f.doc.id, {}, { toFile: true, path: f.path });
    assert.match(saved.text, /应用改第一段/);
    assert.match(saved.text, /agent 改最后一段/);
    assert.equal(saved.fileConflict, null);
    assert.equal(saved.unsynced, false);
    assert.equal(await readFile(f.path, "utf8"), saved.text);
    assert.equal(draft.unsynced, true);
    assert.ok(f.store.mdVersions(f.doc.id).length >= 2);
  } finally { f.close(); }
});

test("overlapping file edits are preserved; a stale conflict decision cannot overwrite a newer file", async () => {
  const f = await fixture("共同的一段。\n");
  try {
    await f.files.save(f.doc.id, { text: "应用修改的一段。\n", base: f.doc });
    await writeFile(f.path, "agent 修改的一段。\n");
    let doc = await f.files.save(f.doc.id, {}, { toFile: true, path: f.path });
    assert.equal(doc.text, "应用修改的一段。\n");
    assert.ok(doc.fileConflict);
    assert.equal(await readFile(f.path, "utf8"), "agent 修改的一段。\n");
    const staleHash = doc.fileConflict.hash;
    await writeFile(f.path, "agent 又修改了一次。\n");
    doc = await f.files.resolve(doc.id, { hash: staleHash, text: "合并完成。\n" });
    assert.ok(doc.fileConflict);
    assert.equal(await readFile(f.path, "utf8"), "agent 又修改了一次。\n");
    doc = await f.files.resolve(doc.id, { hash: doc.fileConflict.hash, text: "手工合并双方修改。\n" });
    assert.equal(doc.fileConflict, null);
    assert.equal(doc.unsynced, false);
    assert.equal(await readFile(f.path, "utf8"), "手工合并双方修改。\n");
    assert.ok(f.store.mdVersions(doc.id).some((v) => v.reason.includes("草稿")));
  } finally { f.close(); }
});

test("a stale application window merges independent edits and cannot silently replace another window's text", async () => {
  const f = await fixture();
  try {
    await f.files.save(f.doc.id, { base: f.doc, text: f.doc.text.replace("第一段", "窗口一") });
    const merged = await f.files.save(f.doc.id, { base: f.doc, text: f.doc.text.replace("最后一段", "窗口二") });
    assert.match(merged.text, /窗口一/);
    assert.match(merged.text, /窗口二/);
    await assert.rejects(f.files.save(f.doc.id, { base: f.doc, text: f.doc.text.replace("第一段", "另一个改法") }), /另一窗口/);
    assert.equal(f.store.mdDocument(f.doc.id).text, merged.text);
    assert.ok(f.store.mdVersions(f.doc.id).some((v) => v.reason.includes("并发")));
  } finally { f.close(); }
});

test("unsaved-as-annotation chats appear in document history and saving an answer twice is idempotent", async () => {
  const f = await fixture();
  try {
    const id = f.store.openChildChat({ kind: "md-selection", mdId: f.doc.id, selection: { id: "history", start: 0, quote: "第一段" } });
    const chat = f.store.saveReply(null, "解释", "回答", undefined, [], id);
    const ids = chat.blocks.filter((b) => b.kind === "reply").map((b) => b.id);
    assert.equal(f.store.reviewHistory("md", f.doc.id)[0].id, id);
    const first = f.store.structure({ type: "selection-to-annotation", chat: id, ids });
    const again = f.store.structure({ type: "selection-to-annotation", chat: id, ids });
    assert.equal(f.store.mdDocument(f.doc.id).comments.length, 1);
    assert.equal(first.reviewAnnotation.commentId, again.reviewAnnotation.commentId);
    assert.equal(f.store.structureLog().length, 1);
    f.store.undoStructure();
    assert.equal(f.store.mdDocument(f.doc.id).comments.length, 0);
    assert.equal(f.store.read(id).selectionAnnotation, undefined);
  } finally { f.close(); }
});

test("deleting a saved annotation keeps its full conversation in document history", async () => {
  const f = await fixture();
  try {
    const id = f.store.openChildChat({ kind: "md-selection", mdId: f.doc.id, selection: { id: "keep-chat", start: 0, quote: "第一段" } });
    const state = f.store.saveReply(null, "解释", "值得保留的解释", undefined, [], id);
    f.store.structure({ type: "selection-to-annotation", chat: id, ids: state.blocks.filter((b) => b.kind === "reply").map((b) => b.id) });
    f.store.saveReply(null, "再追问", "追问答复", undefined, [], id);
    const doc = f.store.mdDocument(f.doc.id);
    await f.files.save(doc.id, { base: doc, comments: [] });
    assert.equal(f.store.mdDocument(doc.id).comments.length, 0);
    assert.equal(f.store.read(id).parent.kind, "md-selection");
    assert.ok(f.store.read(id).blocks.some((block) => block.text === "追问答复"));
    assert.ok(f.store.read(id).blocks.some((block) => block.noteType === "retained-annotation" && block.text === "值得保留的解释"));
    assert.equal(f.store.reviewHistory("md", doc.id)[0].id, id);
  } finally { f.close(); }
});

test("an optimistic document revision prevents a stale writer replacing a newer draft", async () => {
  const f = await fixture();
  try {
    const first = f.store.mdDocument(f.doc.id);
    f.store.saveMdDocument(first.id, { ...first, text: "较新的草稿", expectedVersion: first.version, unsynced: true });
    assert.throws(() => f.store.saveMdDocument(first.id, { ...first, text: "过期的覆盖", expectedVersion: first.version }), /版本已变化/);
    assert.equal(f.store.mdDocument(first.id).text, "较新的草稿");
  } finally { f.close(); }
});

test("removing the underlying file retains the application draft and allows explicit recreation", async () => {
  const f = await fixture();
  try {
    await unlink(f.path);
    const missing = await f.files.open(f.doc.id);
    assert.equal(missing.text, f.doc.text);
    assert.equal(missing.fileConflict.missing, true);
    await assert.rejects(f.files.resolve(missing.id, { hash: "missing", useDisk: true }), /不存在/);
    const recreated = await f.files.resolve(missing.id, { hash: "missing", text: "用户确认重新保存的草稿" });
    assert.equal(await readFile(f.path, "utf8"), recreated.text);
    assert.equal(recreated.fileConflict, null);
    assert.equal(recreated.unsynced, false);
  } finally { f.close(); }
});
