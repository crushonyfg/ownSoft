import assert from "node:assert/strict";
import { test } from "node:test";
import { childKey } from "./child-chats.mjs";
import { NotebookStore } from "./store.mjs";

const claude = { provider: "claude", model: "", effort: "", memberId: "m-1", memberName: "claude1", avatar: "fox" };
const texts = (state) => state.blocks.filter((block) => !block.removed).map((block) => block.text);

function chatWithTwoTurns(store) {
  store.saveReply(null, "问一", "答一", claude);
  return store.saveReply(null, "问二", "答二", claude);
}

test("messages move within a chat and to another chat with their annotations and follow-ups, and back by undo", () => {
  const store = new NotebookStore(":memory:");
  try {
    const first = chatWithTwoTurns(store);
    const [q1, a1, q2] = first.blocks.filter((block) => ["question", "reply"].includes(block.kind));
    // Reorder: the second question goes above the first.
    store.structure({ type: "move", ids: [q2.id], to: first.id, before: q1.id });
    assert.deepEqual(texts(store.read(first.id)).slice(-4), ["问二", "问一", "答一", "答二"]);
    assert.equal(store.undoStructure().label, "移动 1 条消息");
    assert.deepEqual(texts(store.read(first.id)).slice(-4), ["问一", "答一", "问二", "答二"]);
    // An annotated answer with a follow-up moves to another chat; the follow-up goes along.
    const withNote = store.change({ type: "add-note", anchor: { blockId: a1.id, start: 0, quote: "答一" }, text: "批注" }, first.id);
    const note = withNote.notes.at(-1);
    store.saveNoteReply(first.id, note.id, { id: "t-1", question: "追问", answer: "追答", source: claude });
    const other = store.create("另一个").state;
    const moved = store.structure({ type: "move", ids: [a1.id], to: other.id, before: null });
    assert.equal(moved.focus.chat, other.id);
    assert.deepEqual(texts(store.read(other.id)).slice(-1), ["答一"]);
    assert.equal(store.read(other.id).notes[0].turns[0].answer, "追答");
    assert.equal(store.read(first.id).notes.length, 0);
    assert.ok(store.childChat(childKey.note(other.id, note.id)));
    // The rows say where the block is now.
    assert.equal(store.chatOfBlock(a1.id), other.id);
    store.undoStructure();
    assert.equal(store.chatOfBlock(a1.id), first.id);
    assert.equal(store.read(first.id).notes[0].turns[0].answer, "追答");
    assert.deepEqual(texts(store.read(first.id)).slice(-4), ["问一", "答一", "问二", "答二"]);
  } finally {
    store.close();
  }
});

test("an annotation becomes a note block and back, a removed message comes back, all by undo", () => {
  const store = new NotebookStore(":memory:");
  try {
    const state = chatWithTwoTurns(store);
    const answer = state.blocks.find((block) => block.text === "答一");
    const note = store.change({ type: "add-note", anchor: { blockId: answer.id, start: 0, quote: "答一" }, text: "要点" }, state.id).notes.at(-1);
    store.saveNoteReply(state.id, note.id, { id: "t-1", question: "追问", answer: "追答", source: claude });
    const made = store.structure({ type: "note-to-block", chat: state.id, noteId: note.id });
    const after = store.read(state.id);
    assert.equal(after.notes.length, 0);
    assert.equal(after.blocks[after.blocks.findIndex((block) => block.id === answer.id) + 1].text, "要点");
    assert.ok(store.childChat(childKey.note(state.id, note.id)), "the follow-up waits for a turn back");
    store.undoStructure();
    assert.equal(store.read(state.id).notes[0].turns[0].answer, "追答");
    assert.ok(!store.read(state.id).blocks.some((block) => block.id === made.focus.messageId));
    // Removing a message, then undoing it.
    store.structure({ type: "remove", ids: [answer.id] });
    assert.ok(!texts(store.read(state.id)).includes("答一"));
    assert.equal(store.findMessage(answer.id).blocks[0].removed, 1);
    store.undoStructure();
    assert.ok(texts(store.read(state.id)).includes("答一"));
    assert.equal(store.searchMessages("答一")[0].messageId, answer.id);
    assert.deepEqual(store.structureLog().map((entry) => entry.label), []);
    assert.throws(() => store.undoStructure(), /没有可以撤销/);
  } finally {
    store.close();
  }
});

test("relations: what a chat contains, what hangs on a block and what links where", () => {
  const store = new NotebookStore(":memory:");
  try {
    const state = chatWithTwoTurns(store);
    const other = store.create("另一个").state;
    const answer = state.blocks.find((block) => block.text === "答二");
    store.change({ type: "add-note", anchor: { blockId: answer.id, start: 0, quote: "答二" }, text: "批注" }, state.id);
    store.change({ type: "add-blocks", text: `见 [另一个](ownsoft://chat/${other.id})` }, state.id);
    const relations = store.relationsOf(answer.id).map((item) => `${item.fromKind}-${item.relation}-${item.toKind}`);
    assert.deepEqual(relations.sort(), ["block-note-note", "chat-contains-block"]);
    assert.deepEqual(store.relationsOf(other.id).filter((item) => item.relation === "links").map((item) => item.fromKind), ["block"]);
  } finally {
    store.close();
  }
});

test("an image note is marked up (original kept), edited again, restored, and each step undone", async () => {
  const { allAttachmentRefs } = await import("./attachments.mjs");
  const store = new NotebookStore(":memory:");
  try {
    const original = { id: "11111111-1111-1111-1111-111111111111", extension: ".png", name: "截图.png", size: 10 };
    const state = store.change({ type: "add-note-images", refs: [original] });
    const block = state.blocks.find((item) => item.noteType === "image");
    const first = { id: "22222222-2222-2222-2222-222222222222", extension: ".png", name: "截图（已标注）.png", size: 12 };
    const dot = { type: "dot", x: 10, y: 10, r: 4, color: "#e5484d" };
    store.structure({ type: "edit-image", chat: state.id, blockId: block.id, ref: first, edit: { shapes: [dot], width: 100, height: 80 } });
    let saved = store.read(state.id).blocks.find((item) => item.id === block.id);
    assert.equal(saved.attachments[0].id, first.id);
    assert.equal(saved.imageEdit.original.id, original.id);
    assert.ok(allAttachmentRefs(store.read(state.id)).some((ref) => ref.id === original.id), "the original is kept");
    // Editing again keeps the very first original.
    const second = { ...first, id: "33333333-3333-3333-3333-333333333333" };
    store.structure({ type: "edit-image", chat: state.id, blockId: block.id, ref: second, edit: { shapes: [dot, dot], width: 100, height: 80 } });
    saved = store.read(state.id).blocks.find((item) => item.id === block.id);
    assert.deepEqual([saved.attachments[0].id, saved.imageEdit.original.id, saved.imageEdit.shapes.length], [second.id, original.id, 2]);
    // Restore the original, then undo all the way back.
    store.structure({ type: "edit-image", chat: state.id, blockId: block.id, restore: true });
    saved = store.read(state.id).blocks.find((item) => item.id === block.id);
    assert.deepEqual([saved.attachments[0].id, saved.imageEdit], [original.id, undefined]);
    assert.equal(store.undoStructure().label, "恢复原图");
    assert.equal(store.read(state.id).blocks.find((item) => item.id === block.id).attachments[0].id, second.id);
    store.undoStructure();
    assert.equal(store.read(state.id).blocks.find((item) => item.id === block.id).imageEdit.shapes.length, 1);
    store.undoStructure();
    saved = store.read(state.id).blocks.find((item) => item.id === block.id);
    assert.deepEqual([saved.attachments[0].id, saved.imageEdit], [original.id, undefined]);
  } finally {
    store.close();
  }
});
