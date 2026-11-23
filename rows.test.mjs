import assert from "node:assert/strict";
import { test } from "node:test";
import { NotebookStore } from "./store.mjs";

const claude = { provider: "claude", model: "", effort: "", memberId: "m-1", memberName: "claude1", avatar: "fox" };

// Counts row writes by watching the rows' data before and after.
const rowsOf = (store, chatId) => new Map(store.db.prepare("SELECT id, data FROM chat_blocks WHERE chat_id = ?").all(chatId)
  .map((row) => [row.id, row.data]));

test("a chat's messages and annotations are rows; its document no longer holds them", () => {
  const store = new NotebookStore(":memory:");
  try {
    const state = store.saveReply(null, "问题", "回答", claude);
    const reply = state.blocks.find((block) => block.kind === "reply");
    store.change({ type: "add-note", anchor: { blockId: reply.id, start: 0, quote: "回答" }, text: "批注" }, state.id);
    const doc = JSON.parse(store.db.prepare("SELECT snapshot FROM notebook_documents WHERE id = ?").get(state.id).snapshot);
    assert.equal(doc.blocks, undefined);
    assert.equal(doc.notes, undefined);
    const read = store.read(state.id);
    assert.deepEqual(read.blocks.slice(-2).map((block) => block.text), ["问题", "回答"]);
    assert.equal(read.notes[0].text, "批注");
    assert.equal(store.db.prepare("SELECT block_id FROM chat_notes WHERE chat_id = ?").get(state.id).block_id, reply.id);
  } finally {
    store.close();
  }
});

test("saving a chat writes only the rows that changed", () => {
  const store = new NotebookStore(":memory:");
  try {
    store.saveReply(null, "问一", "答一", claude);
    const state = store.saveReply(null, "问二", "答二", claude);
    const before = rowsOf(store, state.id);
    // Mark a row as untouched: if a later write rewrote it, the marker would be gone.
    const untouched = state.blocks.find((block) => block.text === "问一");
    store.db.prepare("UPDATE chat_blocks SET speaker = 'marker' WHERE chat_id = ? AND id = ?").run(state.id, untouched.id);
    const edited = state.blocks.find((block) => block.text === "答二");
    store.change({ type: "edit-document", title: state.title, messages: [{ ids: [edited.id], text: "改过的答二" }] }, state.id);
    const after = rowsOf(store, state.id);
    assert.equal(store.db.prepare("SELECT speaker FROM chat_blocks WHERE chat_id = ? AND id = ?").get(state.id, untouched.id).speaker, "marker");
    assert.notEqual(after.get(edited.id), before.get(edited.id));
    assert.equal(store.read(state.id).blocks.find((block) => block.id === edited.id).text, "改过的答二");
  } finally {
    store.close();
  }
});

test("two copies of a chat object each keep the other's changes to other messages", () => {
  const store = new NotebookStore(":memory:");
  try {
    store.saveReply(null, "问一", "答一", claude);
    const state = store.saveReply(null, "问二", "答二", claude);
    const one = store.read(state.id);
    const two = store.read(state.id);
    one.blocks.find((block) => block.text === "答一").text = "窗口一改的";
    store.write(one);
    two.blocks.find((block) => block.text === "答二").text = "窗口二改的";
    store.write(two);
    const texts = store.read(state.id).blocks.map((block) => block.text);
    assert.ok(texts.includes("窗口一改的"));
    assert.ok(texts.includes("窗口二改的"));
  } finally {
    store.close();
  }
});

test("a chat made from selected messages keeps their ids without taking them from the original", () => {
  const store = new NotebookStore(":memory:");
  try {
    const state = store.saveReply(null, "问题", "回答", claude);
    const question = state.blocks.find((block) => block.kind === "question");
    const copy = store.createFromMessages(state.id, [question.id]).state;
    assert.ok(store.read(state.id).blocks.some((block) => block.id === question.id));
    assert.ok(store.read(copy.id).blocks.some((block) => block.id === question.id));
    assert.equal(store.chatOfBlock(question.id, state.id), state.id);
    store.deleteNotebook(copy.id);
    assert.ok(store.read(state.id).blocks.some((block) => block.id === question.id));
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chat_blocks WHERE chat_id = ?").get(copy.id).n, 0);
  } finally {
    store.close();
  }
});

test("an annotation's own text can be highlighted and underlined, toggled like messages", () => {
  const store = new NotebookStore(":memory:");
  try {
    const state = store.saveReply(null, "问题", "回答", claude);
    const reply = state.blocks.find((block) => block.kind === "reply");
    const note = store.change({ type: "add-note", anchor: { blockId: reply.id, start: 0, quote: "回答" },
      text: "短期均线回归的概率极大。" }, state.id).notes.at(-1);
    store.change({ type: "mark", style: "highlight", noteId: note.id, anchor: { start: 0, quote: "短期均线回归" } }, state.id);
    store.change({ type: "mark", style: "underline", noteId: note.id, anchor: { start: 7, quote: "概率极大" } }, state.id);
    assert.deepEqual(store.read(state.id).notes[0].marks.map((mark) => [mark.style, mark.quote]),
      [["highlight", "短期均线回归"], ["underline", "概率极大"]]);
    store.change({ type: "mark", style: "highlight", noteId: note.id, anchor: { start: 0, quote: "短期均线回归" } }, state.id);
    assert.deepEqual(store.read(state.id).notes[0].marks.map((mark) => mark.style), ["underline"]);
    assert.throws(() => store.change({ type: "mark", style: "highlight", noteId: note.id, anchor: { start: 3, quote: "不存在" } }, state.id), /选区/);
  } finally {
    store.close();
  }
});
