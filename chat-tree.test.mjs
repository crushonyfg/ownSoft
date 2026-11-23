import assert from "node:assert/strict";
import { test } from "node:test";
import { childKey } from "./child-chats.mjs";
import { NotebookStore } from "./store.mjs";

const claude = { provider: "claude", model: "", effort: "", memberId: "m-1", memberName: "claude1", avatar: "fox" };
const shape = (node) => [node.kind, node.turns ?? null, node.children.map(shape)];

test("a chat's tree shows its annotations, branches, windows and PDFs, and what grew out of those", () => {
  const store = new NotebookStore(":memory:");
  try {
    const saved = store.saveReply(null, "问题", "这是一段有关键句的回答。", claude);
    const reply = saved.blocks.find((block) => block.kind === "reply");
    let state = store.change({ type: "add-note", anchor: { blockId: reply.id, start: 0, quote: "这是" }, text: "我的批注" });
    const note = state.notes.at(-1);
    state = store.change({ type: "create-branch", anchor: { blockId: reply.id, start: 2, quote: "一段" } }, state.id);
    const branch = state.branches.at(-1);
    state = store.change({ type: "add-thread", memberId: "m-1" }, state.id);
    store.saveNoteReply(state.id, note.id, { id: "t-1", question: "展开说说", answer: "展开的回答。", source: claude });
    store.saveReply(branch.id, "分支问题", "分支回答", claude, [], state.id);
    // The annotation's follow-up is a full chat; an annotation made inside it hangs below it.
    const child = store.childChat(childKey.note(state.id, note.id));
    const childReply = child.blocks.find((block) => block.kind === "reply");
    store.change({ type: "add-note", anchor: { blockId: childReply.id, start: 0, quote: "展开" }, text: "二级批注" }, child.id);

    const tree = store.chatTree(state.id);
    assert.equal(tree.chatId, state.id);
    assert.deepEqual(shape(tree), ["chat", 1, [["note", 1, [["note", 0, []]]], ["branch", 1, []], ["thread", 0, []]]]);
    const [noteNode, branchNode, threadNode] = tree.children;
    assert.equal(noteNode.chatId, child.id);
    assert.equal(noteNode.quote, "这是");
    assert.deepEqual(noteNode.open, { kind: "note", notebookId: state.id, itemId: note.id });
    assert.equal(noteNode.children[0].open.notebookId, child.id);
    assert.equal(noteNode.children[0].chatId, null);
    assert.equal(branchNode.quote, "一段");
    assert.equal(threadNode.memberId, "m-1");
    // A child chat's own tree knows where it came from.
    assert.equal(store.chatTree(child.id).parent.kind, "note");
  } finally {
    store.close();
  }
});

test("a review's tree lists its whole-document chat and each annotation's follow-up", () => {
  const store = new NotebookStore(":memory:");
  try {
    const hash = "c".repeat(64);
    const comment = { id: "c-1", page: 3, rects: [[.1, .1, .3, .12]], title: "缺对照", text: "缺对照实验。", quote: "we show",
      priority: "", turns: [{ id: "t-1", question: "补什么？", answer: "补基线。", source: claude }] };
    store.savePdfReview(hash, "论文.pdf", { comments: [comment, { ...comment, id: "c-2", turns: undefined }], chat: [] });
    const tree = store.reviewTree("pdf", hash);
    assert.deepEqual(shape(tree), ["pdf", null, [["pdf-chat", 0, []], ["pdf-comment", 1, []], ["pdf-comment", 0, []]]]);
    assert.equal(tree.children[0].chatId, null);
    assert.equal(tree.children[1].page, 3);
    assert.deepEqual(tree.children[1].open, { kind: "pdf-comment", hash, commentId: "c-1" });
    assert.ok(tree.children[1].chatId);
    assert.equal(store.reviewTree("pdf", "d".repeat(64)), null);
  } finally {
    store.close();
  }
});
