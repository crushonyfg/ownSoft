import assert from "node:assert/strict";
import { test } from "node:test";
import { appendTurn, chatTurns, childKey } from "./child-chats.mjs";
import { mainHistory } from "./notebook.mjs";
import { NotebookStore } from "./store.mjs";

const claude = { provider: "claude", model: "", effort: "", memberId: "m-1", memberName: "claude1", avatar: "fox" };

function withNote(store) {
  const saved = store.saveReply(null, "问题", "这是一段有关键句的回答。", claude);
  const reply = saved.blocks.find((block) => block.kind === "reply");
  const state = store.change({ type: "add-note", anchor: { blockId: reply.id, start: 0, quote: "这是" }, text: "我的批注" });
  return { state, note: state.notes.at(-1) };
}

test("an annotation's follow-up is a chat of its own that the annotation still shows", () => {
  const store = new NotebookStore(":memory:");
  try {
    const { state, note } = withNote(store);
    store.saveNoteReply(state.id, note.id, { id: "t-1", question: "展开说说", answer: "第一段。\n\n第二段。", source: claude });
    const parent = store.read(state.id);
    assert.deepEqual(parent.notes[0].turns.map((turn) => [turn.id, turn.question, turn.answer]), [["t-1", "展开说说", "第一段。\n\n第二段。"]]);
    // The annotation's row does not keep the turns; they live in the child chat.
    const row = JSON.parse(store.db.prepare("SELECT data FROM chat_notes WHERE id = ?").get(note.id).data);
    assert.equal(row.turns, undefined);
    const child = store.childChat(childKey.note(state.id, note.id));
    assert.equal(child.parent.kind, "note");
    assert.equal(child.parent.notebookId, state.id);
    // As a full chat, models see who said what, as in the main chat.
    assert.deepEqual(mainHistory(child), [{ question: "展开说说", answer: "【claude1】\n第一段。\n\n第二段。", attachments: [] }]);
    assert.ok(!store.library().items.some((item) => item.id === child.id));
    // Edited in the full chat, the annotation shows the edit.
    const firstReply = child.blocks.find((block) => block.kind === "reply");
    const group = child.blocks.filter((block) => block.kind === "reply").map((block) => block.id);
    store.change({ type: "edit-document", title: child.title, messages: [{ ids: group, text: "改过的回答" }] }, child.id);
    assert.equal(store.read(state.id).notes[0].turns[0].answer, "改过的回答");
    assert.equal(store.read(state.id).notes[0].turns[0].id, firstReply.id);
    // A reply in the child chat makes the parent chat newer, so its windows refresh.
    const before = store.read(state.id).revision;
    store.saveReply(null, "再问", "再答", claude, [], child.id);
    assert.ok(store.read(state.id).revision > before);
    assert.equal(store.read(state.id).notes[0].turns.length, 2);
    // Deleting the annotation keeps its chat aside, so undoing the deletion brings both back.
    store.change({ type: "delete-note", id: note.id }, state.id);
    assert.equal(store.read(state.id).notes.length, 0);
    assert.ok(store.childChat(childKey.note(state.id, note.id)));
    assert.equal(store.undoStructure().label, "删除批注");
    assert.equal(store.read(state.id).notes[0].turns.length, 2);
  } finally {
    store.close();
  }
});

test("branches and private windows keep their turns in child chats, edits and deletions included", () => {
  const store = new NotebookStore(":memory:");
  try {
    const saved = store.saveReply(null, "问题", "分支从这里开始。", claude);
    const reply = saved.blocks.find((block) => block.kind === "reply");
    const state = store.change({ type: "create-branch", anchor: { blockId: reply.id, start: 0, quote: "分支" } });
    const branchId = state.branches[0].id;
    store.saveReply(branchId, "分支问题", "分支回答", claude, [], state.id);
    const turnId = store.read(state.id).branches[0].turns[0].id;
    store.change({ type: "edit-answer", id: branchId, turnId, text: "改过的分支回答" }, state.id);
    assert.equal(chatTurns(store.childChat(childKey.branch(state.id, branchId)))[0].answer, "改过的分支回答");
    const withThread = store.change({ type: "add-thread", memberId: "m-1" }, state.id);
    const threadId = withThread.threads[0].id;
    store.saveThreadReply(state.id, threadId, { id: "p-1", question: "私下问", answer: "私下答", source: claude });
    store.saveThreadReply(state.id, threadId, { id: "p-2", question: "再问", answer: "再答", source: claude });
    store.change({ type: "delete-thread-turn", id: threadId, turnId: "p-1" }, state.id);
    assert.deepEqual(store.read(state.id).threads[0].turns.map((turn) => turn.question), ["再问"]);
    store.change({ type: "delete-thread", id: threadId }, state.id);
    assert.equal(store.childChat(childKey.thread(state.id, threadId)), null);
    store.change({ type: "delete-branch", id: branchId }, state.id);
    assert.equal(store.childChat(childKey.branch(state.id, branchId)), null);
  } finally {
    store.close();
  }
});

test("a review's conversations are child chats, and saving an older copy never removes messages", () => {
  const store = new NotebookStore(":memory:");
  try {
    const hash = "b".repeat(64);
    const comment = { id: "c-1", page: 1, rects: [[.1, .1, .3, .12]], title: "批注", text: "缺对照。", quote: "we show",
      priority: "", turns: [{ id: "t-1", question: "补什么？", answer: "补基线。", source: claude }] };
    const chat = [{ id: "t-2", question: "总结", answer: "三点。", source: claude }];
    store.savePdfReview(hash, "论文.pdf", { comments: [comment], chat });
    const stored = JSON.parse(store.db.prepare("SELECT data FROM pdf_reviews WHERE hash = ?").get(hash).data);
    assert.deepEqual([stored.chat, stored.comments[0].turns], [[], undefined]);
    // An answer arrives while the review page still holds the old copy.
    store.appendChildTurn(childKey.pdfChat(hash), { kind: "pdf-chat", hash, title: "全文对话" },
      { id: "t-3", question: "再问", answer: "再答", source: claude });
    store.savePdfReview(hash, "论文.pdf", { comments: [comment], chat });
    assert.deepEqual(store.pdfReview(hash).chat.map((turn) => turn.id), ["t-2", "t-3"]);
    assert.deepEqual(store.pdfReviews().map((item) => item.chat), [2]);
    const chatId = store.openChildChat({ kind: "pdf-chat", hash });
    assert.equal(store.read(chatId).parent.hash, hash);
    // Removing the annotation removes its follow-up; removing the review removes the rest.
    store.savePdfReview(hash, "论文.pdf", { comments: [], chat });
    assert.equal(store.childChat(childKey.pdfComment(hash, "c-1")), null);
    store.removePdfReview(hash);
    assert.equal(store.childChat(childKey.pdfChat(hash)), null);
  } finally {
    store.close();
  }
});

test("conversations stored inline by earlier versions move into child chats", () => {
  const store = new NotebookStore(":memory:");
  try {
    const { state, note } = withNote(store);
    // A chat as an earlier version saved it: one document with its messages and annotations inline.
    const raw = structuredClone(store.read(state.id));
    raw.notes[0].turns = [{ id: "old-1", question: "旧追问", answer: "旧回答", source: claude }];
    store.db.prepare("UPDATE notebook_documents SET snapshot = ? WHERE id = ?").run(JSON.stringify(raw), state.id);
    store.db.prepare("DELETE FROM chat_blocks WHERE chat_id = ?").run(state.id);
    store.db.prepare("DELETE FROM chat_notes WHERE chat_id = ?").run(state.id);
    assert.ok(store.needsRowMove());
    store.db.prepare("INSERT INTO pdf_reviews VALUES (?, ?, ?, ?)").run("c".repeat(64), "旧.pdf",
      JSON.stringify({ comments: [], chat: [{ id: "old-2", question: "旧全文问", answer: "旧全文答" }], page: 1 }), Date.now());
    // Before moving, the old turns are still shown.
    assert.equal(store.read(state.id).notes[0].turns[0].answer, "旧回答");
    assert.ok(store.needsConversationMove());
    store.moveConversations();
    store.moveToRows();
    assert.ok(!store.needsConversationMove());
    assert.ok(!store.needsRowMove());
    assert.equal(store.read(state.id).blocks.length, raw.blocks.length);
    assert.equal(chatTurns(store.childChat(childKey.note(state.id, note.id)))[0].id, "old-1");
    assert.equal(store.read(state.id).notes[0].turns[0].answer, "旧回答");
    assert.equal(store.pdfReview("c".repeat(64)).chat[0].answer, "旧全文答");
  } finally {
    store.close();
  }
});

test("several members answering the same question stay under that question", () => {
  const chat = { blocks: [] };
  appendTurn(chat, { id: "a", question: "怎么看？", answer: "甲的看法", source: claude });
  appendTurn(chat, { id: "b", question: "怎么看？", answer: "乙的看法", source: { ...claude, memberName: "gpt1" } });
  appendTurn(chat, { id: "c", question: "下一个", answer: "丙" });
  assert.deepEqual(chat.blocks.filter((block) => block.kind === "question").map((block) => block.text), ["怎么看？", "下一个"]);
  assert.deepEqual(chatTurns(chat).map((turn) => [turn.id, turn.question]), [["a", "怎么看？"], ["b", "怎么看？"], ["c", "下一个"]]);
});

test("conversations talk with the members of the chat they grew from, a review's with the chat it was opened from", () => {
  const store = new NotebookStore(":memory:");
  try {
    const settings = { profiles: [{ id: "claude-native", provider: "claude" }, { id: "gemini-native", provider: "gemini" }],
      members: [{ id: "m-1", name: "claude1", profileId: "claude-native" }], defaultMember: "m-1" };
    const { state } = store.changeMembers(store.read().id, { type: "member-add", profileId: "gemini-native", name: "gemini1" }, settings);
    assert.deepEqual(state.members.map((member) => member.name), ["claude1", "gemini1"]);
    // A review opened from this chat: its whole-document chat has the same members.
    const hash = "e".repeat(64);
    store.savePdfReview(hash, "论文.pdf", { comments: [], chat: [] });
    const chatId = store.openChildChat({ kind: "pdf-chat", hash, rosterId: state.id });
    const chat = store.read(chatId);
    assert.deepEqual(chat.inherited.members.map((member) => member.name), ["claude1", "gemini1"]);
    assert.equal(JSON.parse(store.db.prepare("SELECT snapshot FROM notebook_documents WHERE id = ?").get(chatId).snapshot).inherited, undefined);
    // Editing members there gives it its own copy of that roster.
    const own = store.changeMembers(chatId, { type: "member-add", profileId: "claude-native", name: "审稿人" }, settings).state;
    assert.deepEqual(own.members.map((member) => member.name), ["claude1", "gemini1", "审稿人"]);
    assert.equal(store.read(chatId).inherited, undefined);
  } finally {
    store.close();
  }
});

test("later turns see what tools were used before, and the member asked for last answers next by default", () => {
  const store = new NotebookStore(":memory:");
  try {
    const read = { id: "r-1", title: "Read", detail: "C:/texts/paper.txt 120 80", status: "done" };
    const failed = { id: "r-2", title: "WebSearch", detail: "nothing", status: "failed" };
    const saved = store.saveReply(null, "第 3 页讲什么", "讲了收敛性。", claude, [], undefined, [read, failed],
      { recentMember: "m-2" });
    const [turn] = mainHistory(saved);
    assert.match(turn.answer, /^【claude1】\n讲了收敛性。\n\n〔这轮回答前用过的工具/);
    assert.match(turn.answer, /Read C:\/texts\/paper\.txt 120 80〕$/);
    assert.doesNotMatch(turn.answer, /WebSearch/);
    assert.equal(saved.recentMember, "m-2");
    // Choosing the default member by hand takes over again.
    const settings = { profiles: [{ id: "claude-native", provider: "claude" }],
      members: [{ id: "m-1", name: "claude1", profileId: "claude-native" }, { id: "m-2", name: "claude2", profileId: "claude-native" }],
      defaultMember: "m-1" };
    const { state } = store.changeMembers(saved.id, { type: "member-default", id: "m-1" }, settings);
    assert.equal(state.recentMember, undefined);
  } finally {
    store.close();
  }
});

test("an annotation is a node of the chat tree: its text is the first message of its own chat", () => {
  const store = new NotebookStore(":memory:");
  try {
    const { state, note } = withNote(store);
    const chatId = store.openChildChat({ kind: "note", notebookId: state.id, itemId: note.id });
    let child = store.read(chatId);
    // First the message it hangs on (read from the main chat, with the passage marked), then its text.
    assert.deepEqual([child.blocks[0].noteType, child.blocks[0].virtual, child.blocks[0].text], ["source", true, "这是一段有关键句的回答。"]);
    assert.deepEqual(child.blocks[0].marks.map((mark) => [mark.quote, mark.style]), [["这是", "note"]]);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chat_blocks WHERE chat_id = ? AND id = ?").get(chatId, child.blocks[0].id).n, 0);
    const head = child.blocks[1];
    assert.deepEqual([head.kind, head.noteType, head.text], ["paragraph", "annotation", "我的批注"]);
    // Edited in its chat, the margin shows the new text.
    store.change({ type: "edit-document", title: child.title, messages: [{ ids: [head.id], text: "改过的批注" }] }, chatId);
    assert.equal(store.read(state.id).notes[0].text, "改过的批注");
    // Edited in the margin (and highlighted there), its chat follows.
    store.change({ type: "edit-note", id: note.id, text: "页边改的批注" }, state.id);
    store.change({ type: "mark", style: "highlight", noteId: note.id, anchor: { start: 0, quote: "页边" } }, state.id);
    child = store.read(chatId);
    assert.equal(child.blocks[1].text, "页边改的批注");
    assert.deepEqual(child.blocks[1].marks.map((mark) => [mark.quote, mark.blockId]), [["页边", child.blocks[1].id]]);
    // A highlight made in the chat shows in the margin too.
    store.change({ type: "mark", style: "underline", anchor: { blockId: child.blocks[1].id, start: 4, quote: "批注" } }, chatId);
    assert.deepEqual(store.read(state.id).notes[0].marks.map((mark) => mark.style), ["highlight", "underline"]);
    // An annotation on the annotation: the next level of the tree.
    const nested = store.change({ type: "add-note", anchor: { blockId: child.blocks[1].id, start: 0, quote: "页边" }, text: "批注的批注" }, chatId);
    const tree = store.chatTree(state.id);
    assert.equal(tree.children[0].kind, "note");
    assert.equal(tree.children[0].children[0].title, "批注的批注");
    assert.equal(nested.notes[0].text, "批注的批注");
    // Its follow-up turns are still only the questions and answers.
    store.saveNoteReply(state.id, note.id, { id: "t-9", question: "问", answer: "答", source: claude });
    assert.deepEqual(store.read(state.id).notes[0].turns.map((turn) => turn.answer), ["答"]);
    assert.equal(store.read(chatId).blocks.filter((block) => block.noteType === "annotation").length, 1);
  } finally {
    store.close();
  }
});

test("a side question's chat begins with the message it was asked about, like an annotation's", () => {
  const store = new NotebookStore(":memory:");
  try {
    const saved = store.saveReply(null, "问题", "分支从这里开始。", claude);
    const reply = saved.blocks.find((block) => block.kind === "reply");
    const state = store.change({ type: "create-branch", anchor: { blockId: reply.id, start: 0, quote: "分支" } });
    const chatId = store.openChildChat({ kind: "branch", notebookId: state.id, itemId: state.branches[0].id });
    const first = store.read(chatId).blocks[0];
    assert.deepEqual([first.noteType, first.text, first.marks[0].quote], ["source", "分支从这里开始。", "分支"]);
    store.saveReply(null, "分支里问", "分支里答", claude, [], chatId);
    assert.deepEqual(store.read(state.id).branches[0].turns.map((turn) => turn.answer), ["分支里答"]);
  } finally {
    store.close();
  }
});
