import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commentInput, findAnchor, mainHistory, messageGroups, noteOrigin, sharedNoteBlocks, turnInput } from "./notebook.mjs";
import { NotebookStore } from "./store.mjs";
import { Profiles } from "./profiles.mjs";
import { allAttachmentRefs } from "./attachments.mjs";

test("annotation replies stay local and a fork copies their context into editable history", () => {
  const store = new NotebookStore(":memory:");
  try {
    const original = store.saveReply(null, "无关主问题", "演示段落。第二句提供背景。");
    const block = original.blocks.at(-1);
    const note = store.change({ type: "add-note", text: "请核对这里的术语。",
      anchor: { blockId: block.id, start: 0, quote: "演示段落" } }).notes[0];
    const turn = { id: "comment-turn", question: "哪个术语？", answer: "段落。" };
    const saved = store.saveNoteReply(original.id, note.id, turn);
    const origin = noteOrigin(saved, saved.notes[0]);
    const followup = commentInput(origin, saved.notes[0].turns, "继续");
    assert.match(followup.context, /演示段落[\s\S]+第二句提供背景[\s\S]+请核对这里的术语/);
    assert.deepEqual(followup.history, [{ question: turn.question, answer: turn.answer }]);
    assert.equal(mainHistory(saved).length, 1);
    const fork = store.create("批注分支", { origin, turns: saved.notes[0].turns }).state;
    assert.deepEqual(turnInput(fork, null, "继续"), followup);
    store.change({ type: "edit-document", title: fork.title, blocks: [
      { id: fork.blocks.at(-1).id, text: "重新核对。" }
    ] }, fork.id);
    assert.equal(mainHistory(store.read(fork.id))[0].answer, "重新核对。");
    assert.deepEqual(store.read(original.id).notes[0].turns, [turn]);
  } finally {
    store.close();
  }
});

test("a reply addressed to a background notebook stays with that notebook", () => {
  const store = new NotebookStore(":memory:");
  try {
    const first = store.read();
    const second = store.create("第二本").state;
    store.saveReply(null, "问", "答", undefined, [], first.id);
    assert.equal(store.activeId(), second.id);
    assert.deepEqual(store.read().blocks, []);
    assert.equal(store.open(first.id).state.blocks.at(-1).text, "答");
    assert.equal(store.library().items.length, 2);
  } finally {
    store.close();
  }
});

test("topics group conversations and moving or removing a topic preserves their content", () => {
  const store = new NotebookStore(":memory:");
  try {
    const original = store.read();
    const topic = store.createFolder("纳指研究");
    const chat = store.create("行情分析", { folderId: topic.folderId }).state;
    store.saveReply(null, "问题", "回答", undefined, [], chat.id);
    assert.equal(store.library().items.find((item) => item.id === chat.id).folderId, topic.folderId);
    assert.equal(store.library().folders[0].name, "纳指研究");
    assert.equal(store.renameNotebook(chat.id, "趋势分析").state.title, "趋势分析");
    store.renameFolder(topic.folderId, "市场研究");
    assert.equal(store.library().folders[0].name, "市场研究");
    const selected = store.createFromMessages(chat.id, [store.read(chat.id).blocks.find((block) =>
      block.kind === "question").id]).state;
    assert.equal(selected.folderId, topic.folderId);
    store.moveNotebook(selected.id, null);
    assert.equal(store.read(selected.id).folderId, undefined);
    store.deleteFolder(topic.folderId);
    assert.equal(store.read(chat.id).folderId, undefined);
    assert.equal(mainHistory(store.read(chat.id))[0].answer, "回答");
    store.deleteNotebook(chat.id);
    assert.equal(store.library().items.some((item) => item.id === chat.id), false);
    assert.equal(store.read(original.id).id, original.id);
  } finally {
    store.close();
  }
});

test("deleting the last conversation opens a fresh starter notebook", () => {
  const store = new NotebookStore(":memory:");
  try {
    const old = store.read();
    const result = store.deleteNotebook(old.id);
    assert.notEqual(result.state.id, old.id);
    assert.equal(result.items.length, 1);
    assert.equal(result.active, result.state.id);
    assert.equal(result.state.title, "我的工作笔记");
  } finally {
    store.close();
  }
});

test("main chat uses the edited transcript and opted-in memories; sidebar history stays independent", () => {
  const store = new NotebookStore(":memory:");
  try {
    const first = store.saveReply(null, "主问题", "原来的答案。\n\n移除这段。\n\n这段仅显示。");
    const [starter, , question, reply, removed, excluded] = first.blocks;
    const anchor = { blockId: starter.id, start: 0, quote: starter.text.slice(0, 4) };
    const branch = store.change({ type: "create-branch", anchor }).branches[0];
    store.saveReply(branch.id, "侧栏问题", "侧栏答案");
    const note = store.change({ type: "add-note", branchId: branch.id, text: "记住我选择的摘录" }).notes[0];
    store.change({ type: "pin-note", id: note.id });
    assert.deepEqual(turnInput(store.read(), null, "继续").memories, []);
    store.change({ type: "main-memory", noteId: note.id, enabled: true });
    const edited = store.change({
      type: "edit-document", title: first.title, blocks: [
        { id: question.id, text: "编辑后的问题", included: true },
        { id: reply.id, text: "编辑后的答案", included: true },
        { id: removed.id, text: removed.text, removed: true },
        { id: excluded.id, text: excluded.text, included: false }
      ]
    });
    assert.deepEqual(mainHistory(edited), [
      { question: "编辑后的问题", answer: "编辑后的答案", attachments: [] }
    ]);
    assert.deepEqual(turnInput(edited, null, "继续"), {
      context: "", memories: ["记住我选择的摘录"],
      history: [{ question: "编辑后的问题", answer: "编辑后的答案" }], question: "继续"
    });
    assert.deepEqual(turnInput(edited, edited.branches[0], "追问").history,
      [{ question: "侧栏问题", answer: "侧栏答案" }]);
  } finally {
    store.close();
  }
});

test("editing a complete assistant message keeps its conversation turn and anchored note", () => {
  const store = new NotebookStore(":memory:");
  try {
    const saved = store.saveReply(null, "问题", "第一段。\n\n第二段值得批注。");
    const replies = saved.blocks.filter((block) => block.kind === "reply");
    assert.equal(replies.length, 2);
    const note = store.change({ type: "add-note", text: "留下这条批注",
      anchor: { blockId: replies[1].id, start: 0, quote: "第二段" } }).notes[0];
    const edited = store.change({ type: "edit-document", title: saved.title, messages: [{
      ids: replies.map((block) => block.id), text: "改写开头。\n\n第二段继续保留。", included: true
    }] });
    assert.deepEqual(mainHistory(edited).map(({ question, answer }) => ({ question, answer })),
      [{ question: "问题", answer: "改写开头。\n\n第二段继续保留。" }]);
    assert.equal(edited.notes.find((item) => item.id === note.id).anchor.blockId, replies[0].id);
    assert.equal(edited.blocks.find((block) => block.id === replies[1].id).removed, true);
  } finally {
    store.close();
  }
});

test("selected messages create an independent chat with its question, tool log, notes and branch", () => {
  const store = new NotebookStore(":memory:");
  try {
    const first = store.saveReply(null, "第一问", "第一答");
    const second = store.saveReply(null, "第二问", "第二答前段。\n\n第二答后段。",
      { provider: "gpt" }, [], first.id, [{ id: "web-1", title: "搜索网页", status: "done" }]);
    const question = second.blocks.find((block) => block.kind === "question" && block.text === "第二问");
    const reply = second.blocks.find((block) => block.kind === "reply" && block.text === "第二答后段。");
    const note = store.change({ type: "add-note", text: "保留批注",
      anchor: { blockId: reply.id, start: 0, quote: "第二答" } }).notes[0];
    store.change({ type: "pin-note", id: note.id });
    store.change({ type: "main-memory", noteId: note.id, enabled: true });
    store.change({ type: "create-branch", anchor: { blockId: reply.id, start: 0, quote: "第二答" } });
    const copied = store.createFromMessages(second.id, [second.blocks.find((block) =>
      block.kind === "reply" && block.text === "第二答前段。").id]).state;
    assert.deepEqual(mainHistory(copied).map(({ question, answer }) => ({ question, answer })),
      [{ question: "第二问", answer: "第二答前段。\n\n第二答后段。" }]);
    assert.equal(copied.blocks.find((block) => block.id === question.id)?.text, "第二问");
    assert.equal(copied.blocks.find((block) => block.tools?.length)?.tools[0].title, "搜索网页");
    assert.equal(copied.notes[0].id, note.id);
    assert.equal(copied.branches.length, 1);
    assert.deepEqual(copied.mainMemoryIds, [note.id]);
    assert.equal(mainHistory(store.read(second.id)).length, 2);
  } finally {
    store.close();
  }
});

test("public note blocks enter model context, can be reordered, and a reply can become a note", () => {
  const store = new NotebookStore(":memory:");
  try {
    const initial = store.read();
    assert.equal(sharedNoteBlocks(initial).length, 0);
    store.change({ type: "add-shared-block", text: "第一条公共笔记" });
    store.change({ type: "add-shared-block", text: "第二条公共笔记" });
    const notes = store.read().blocks.filter((block) => block.kind === "paragraph" && !block.id.startsWith("starter-"));
    store.change({ type: "move-shared-block", id: notes[1].id, beforeId: notes[0].id });
    assert.deepEqual(sharedNoteBlocks(store.read()).map((block) => block.text),
      ["第二条公共笔记", "第一条公共笔记"]);
    const answer = store.saveReply(null, "问题", "可转写的回答");
    const reply = answer.blocks.find((block) => block.kind === "reply");
    const replyAnchor = { blockId: reply.id, start: 0, quote: "可转写" };
    store.change({ type: "create-branch", anchor: replyAnchor });
    const annotation = store.change({ type: "add-note", anchor: replyAnchor, text: "保留这一处批注" }).notes.at(-1);
    store.change({ type: "mark", anchor: replyAnchor, style: "highlight" });
    assert.match(turnInput(store.read(), store.read().branches[0], "侧边追问").context, /公共笔记/);
    store.change({ type: "convert-reply", ids: [reply.id] });
    const converted = store.read();
    assert.equal(mainHistory(converted)[0].answer, "");
    assert.match(turnInput(converted, null, "继续").context, /可转写的回答/);
    const replacement = sharedNoteBlocks(converted).at(-1);
    assert.equal(replacement.text, "可转写的回答");
    assert.equal(converted.blocks.find((block) => block.id === reply.id).removed, true);
    assert.equal(converted.blocks.find((block) => block.id === reply.id).text, "");
    assert.equal(converted.branches[0].anchor.blockId, replacement.id);
    assert.equal(converted.notes.find((note) => note.id === annotation.id).anchor.blockId, replacement.id);
    assert.equal(replacement.marks[0].start, 0);
    store.change({ type: "edit-document", title: converted.title, messages: [{
      ids: [notes[0].id], text: "第一条公共笔记", included: false
    }] });
    assert.doesNotMatch(turnInput(store.read(), null, "继续").context, /第一条公共笔记/);
    const image = { id: "11111111-2222-4333-8444-555555555555", extension: ".png", name: "图表.png", size: 120 };
    store.change({ type: "add-note-images", refs: [image] });
    assert.match(turnInput(store.read(), null, "继续").context, /图片「图表.png」/);
    assert.deepEqual(allAttachmentRefs(store.read()).find((ref) => ref.id === image.id), image);
  } finally {
    store.close();
  }
});

test("conversion replaces a multi-paragraph answer while preserving anchors, files and chosen context", () => {
  const store = new NotebookStore(":memory:");
  try {
    const first = store.saveReply(null, "第一问", "前段。\n\n后段需要批注。");
    const question = first.blocks.find((block) => block.kind === "question");
    const replies = first.blocks.filter((block) => block.kind === "reply");
    const anchor = { blockId: replies[1].id, start: 0, quote: "后段" };
    const note = store.change({ type: "add-note", anchor, text: "这条批注要留下" }).notes.at(-1);
    store.change({ type: "mark", anchor, style: "underline" });
    store.saveReply(null, "第二问", "第二答");
    store.change({ type: "set-context", ids: [question.id, replies[0].id], noteIds: [] });
    store.change({ type: "convert-message", ids: replies.map((block) => block.id) });
    const state = store.read();
    const replacement = state.blocks.find((block) => block.kind === "paragraph" && block.text === "前段。\n\n后段需要批注。");
    assert.ok(replacement);
    assert.ok(replies.every((reply) => state.blocks.find((block) => block.id === reply.id).removed));
    assert.equal(state.notes.find((item) => item.id === note.id).anchor.blockId, replacement.id);
    assert.equal(state.notes.find((item) => item.id === note.id).anchor.start, "前段。\n\n".length);
    assert.equal(replacement.marks[0].start, "前段。\n\n".length);
    assert.ok(state.context.ids.includes(replacement.id));
    assert.match(turnInput(state, null, "继续").context, /前段。[\s\S]*后段需要批注/);
    assert.equal(mainHistory(state)[0].answer, "");
  } finally {
    store.close();
  }
});

test("converting an attachment-only question keeps its PDF in the replacement note", () => {
  const store = new NotebookStore(":memory:");
  try {
    const pdf = { id: "11111111-2222-4333-8444-555555555558", extension: ".pdf", name: "论文.pdf", size: 100 };
    const saved = store.saveReply(null, "请阅读附件", "收到", undefined, [pdf]);
    const question = saved.blocks.find((block) => block.kind === "question");
    store.change({ type: "convert-message", ids: [question.id] });
    const converted = store.read();
    const replacement = converted.blocks.find((block) => block.kind === "paragraph" &&
      block.text === "请阅读附件");
    assert.deepEqual(replacement.attachments, [pdf]);
    assert.equal(converted.blocks.find((block) => block.id === question.id).attachments, undefined);
    assert.equal(allAttachmentRefs(converted).filter((ref) => ref.id === pdf.id).length, 1);
  } finally {
    store.close();
  }
});

test("note blocks can be inserted and moved anywhere in the conversation without splitting a reply", () => {
  const store = new NotebookStore(":memory:");
  try {
    const kinds = () => store.read().blocks.filter((block) => !block.id.startsWith("starter-"))
      .map((block) => block.kind === "paragraph" ? block.text : block.kind);
    store.saveReply(null, "问题一", "第一段\n\n第二段");
    store.saveReply(null, "问题二", "回答二");
    const firstReply = store.read().blocks.find((block) => block.kind === "reply");
    store.change({ type: "add-shared-block", text: "回答一之后", afterId: firstReply.id });
    assert.deepEqual(kinds(), ["question", "reply", "reply", "回答一之后", "question", "reply"]);
    store.change({ type: "add-shared-block", text: "最前面", afterId: null });
    assert.equal(store.read().blocks[0].text, "最前面");
    store.change({ type: "add-shared-block", text: "末尾" });
    assert.equal(store.read().blocks.at(-1).text, "末尾");
    const last = store.read().blocks.at(-1);
    const secondReplyPart = store.read().blocks.filter((block) => block.kind === "reply")[1];
    store.change({ type: "move-shared-block", id: last.id, beforeId: secondReplyPart.id });
    assert.deepEqual(kinds(), ["最前面", "question", "末尾", "reply", "reply", "回答一之后", "question", "reply"]);
    assert.deepEqual(mainHistory(store.read()).map((turn) => turn.answer), ["第一段\n\n第二段", "回答二"]);
    store.change({ type: "move-shared-block", id: last.id, beforeId: null });
    assert.equal(store.read().blocks.at(-1).text, "末尾");
    const image = { id: "11111111-2222-4333-8444-555555555556", extension: ".png", name: "图.png", size: 1 };
    const question = store.read().blocks.find((block) => block.kind === "question");
    store.change({ type: "add-note-images", refs: [image], afterId: question.id });
    const blocks = store.read().blocks;
    assert.equal(blocks[blocks.findIndex((block) => block.id === question.id) + 1].noteType, "image");
    const replyTwo = blocks.findLast((block) => block.kind === "reply");
    store.change({ type: "convert-reply", ids: [replyTwo.id] });
    const converted = store.read().blocks;
    assert.equal(converted[converted.findIndex((block) => block.id === replyTwo.id) + 1].text, "回答二");
    assert.throws(() => store.change({ type: "add-shared-block", text: "x", afterId: "missing" }), /插入位置/);
  } finally {
    store.close();
  }
});

test("group members each speak through an account with their own model, avatar and usage", () => {
  const store = new NotebookStore(":memory:");
  try {
    const profiles = new Profiles(store.db);
    const initial = profiles.read();
    assert.deepEqual(initial.members.map((member) => member.name), ["gpt1", "claude1"]);
    assert.equal(profiles.member().member.name, "gpt1");
    profiles.change({ type: "model", model: "gpt-first" });
    profiles.change({ type: "effort", effort: "low" });
    assert.deepEqual([profiles.member().member.model, profiles.member().member.effort], ["gpt-first", "low"]);
    profiles.change({ type: "account-add", provider: "claude", name: "工作" });
    const work = profiles.read().profiles.at(-1);
    const claude2 = profiles.read().members.at(-1);
    assert.equal(claude2.name, "claude2");
    assert.equal(claude2.profileId, work.id);
    profiles.change({ type: "member-update", id: claude2.id, name: "评审", model: "opus", avatar: "owl" });
    assert.throws(() => profiles.change({ type: "member-update", id: claude2.id, name: "GPT1" }), /已经有/);
    assert.throws(() => profiles.change({ type: "member-update", id: claude2.id, name: "a b" }), /不要有空格/);
    profiles.change({ type: "member-default", id: claude2.id });
    assert.equal(profiles.member().profile.id, work.id);
    profiles.change({ type: "member-add", profileId: work.id });
    assert.equal(profiles.read().members.at(-1).name, "claude2");
    profiles.recordUsage(claude2.id, { inputTokens: 100, outputTokens: 20 });
    profiles.recordUsage(claude2.id, { inputTokens: 5, outputTokens: 1 });
    assert.deepEqual([profiles.read().usage[claude2.id].turns, profiles.read().usage[claude2.id].outputTokens], [2, 21]);
    profiles.change({ type: "member-remove", id: profiles.read().members.at(-1).id });
    profiles.change({ type: "member-remove", id: initial.members[1].id });
    assert.equal(profiles.read().members.length, 2);
    profiles.change({ type: "members-import" });
    // The removed claude1's account, plus the Gemini (Antigravity) login.
    assert.equal(profiles.read().lastImport, 2);
    assert.ok(profiles.read().members.some((member) => member.name === "gemini1"));
    assert.throws(() => profiles.change({ type: "account-add", provider: "gemini", name: "第二个" }), /本机/);
    assert.throws(() => profiles.change({ type: "account-remove", id: "gpt-native" }), /本机账户/);
    profiles.change({ type: "account-remove", id: work.id });
    assert.ok(profiles.read().members.every((member) => member.profileId !== work.id));
    assert.equal(new Profiles(store.db).read().members.length, profiles.read().members.length);
  } finally {
    store.close();
  }
});

test("replies from different members stay separate and are labelled in the shared history", () => {
  const store = new NotebookStore(":memory:");
  try {
    store.saveReply(null, "@gpt1 @claude1 各说一句", "第一段\n\n第二段", { provider: "gpt", memberName: "gpt1" });
    store.saveReply(null, "@gpt1 @claude1 各说一句", "我是 Claude", { provider: "claude", memberName: "claude1" },
      [], undefined, [], { continueTurn: true });
    const notebook = store.read();
    const groups = messageGroups(notebook.blocks).filter((group) => group.kind === "reply");
    assert.deepEqual(groups.map((group) => group.blocks.length), [2, 1]);
    assert.equal(groups[1].blocks[0].source.memberName, "claude1");
    assert.equal(mainHistory(notebook).at(-1).answer, "【gpt1】\n第一段\n\n第二段\n\n【claude1】\n我是 Claude");
    assert.equal(mainHistory(notebook).filter((turn) => turn.question.startsWith("@gpt1")).length, 1);
    const ids = groups[0].blocks.map((block) => block.id);
    store.change({ type: "edit-document", title: notebook.title, messages: [{ ids, text: "合并后" }] });
    assert.throws(() => store.change({ type: "edit-document", title: notebook.title,
      messages: [{ ids: [ids[0], groups[1].blocks[0].id], text: "x" }] }), /消息范围无效/);
  } finally {
    store.close();
  }
});

test("chat appearance persists across account switches", () => {
  const store = new NotebookStore(":memory:");
  try {
    const profiles = new Profiles(store.db);
    profiles.change({ type: "appearance", appearance: {
      background: "night", userAvatar: "cat", claudeAvatar: "robot"
    } });
    assert.deepEqual(new Profiles(store.db).read().appearance, {
      background: "night", userAvatar: "cat", gptAvatar: "robot", claudeAvatar: "robot"
    });
    assert.throws(() => profiles.change({ type: "appearance", appearance: { background: "invalid" } }),
      /外观设置无效/);
  } finally {
    store.close();
  }
});

test("switching between GPT and Claude accounts keeps one notebook conversation and its selected memory", () => {
  const store = new NotebookStore(":memory:");
  try {
    const profiles = new Profiles(store.db);
    profiles.change({ type: "account-add", provider: "gpt", name: "个人" });
    const gptMember = profiles.read().members.at(-1);
    const first = store.saveReply(null, "共同的问题", "共同的回答");
    const starter = first.blocks[0];
    const note = store.change({ type: "add-note", text: "两个模型都要记住的内容",
      anchor: { blockId: starter.id, start: 0, quote: starter.text.slice(0, 4) } }).notes[0];
    store.change({ type: "pin-note", id: note.id });
    store.change({ type: "main-memory", noteId: note.id, enabled: true });

    profiles.change({ type: "account-add", provider: "claude", name: "工作" });
    const claudeMember = profiles.read().members.at(-1);
    for (const id of [gptMember.id, claudeMember.id, gptMember.id]) {
      profiles.change({ type: "member-default", id });
      assert.equal(profiles.member().member.id, id);
      assert.deepEqual(turnInput(store.read(), null, "继续"), {
        context: "", memories: ["两个模型都要记住的内容"],
        history: [{ question: "共同的问题", answer: "共同的回答" }], question: "继续"
      });
    }
    assert.equal(new Profiles(store.db).member().member.id, gptMember.id);
  } finally {
    store.close();
  }
});

test("a saved excerpt survives deletion of its branch and opening the database again", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ai-notebook-test-")), "notes.sqlite");
  let store = new NotebookStore(path);
  const block = store.read().blocks[0];
  const anchor = { blockId: block.id, start: 0, quote: block.text.slice(0, 10) };
  const branch = store.change({ type: "create-branch", anchor }).branches[0];
  store.saveReply(branch.id, "问题", "有用的解释");
  store.change({ type: "add-note", branchId: branch.id, text: "有用的解释" });
  store.change({ type: "delete-branch", id: branch.id });
  store.close();
  store = new NotebookStore(path);
  try {
    const state = store.read();
    assert.deepEqual(state.branches, []);
    assert.deepEqual(state.notes[0].anchor, anchor);
    assert.equal(state.notes[0].text, "有用的解释");
  } finally {
    store.close();
  }
});

test("a new branch has its own paragraph, selected memories, and conversation", () => {
  const store = new NotebookStore(":memory:");
  try {
    const [first, second] = store.read().blocks;
    const firstAnchor = { blockId: first.id, start: 0, quote: first.text.slice(0, 5) };
    const secondAnchor = { blockId: second.id, start: 0, quote: second.text.slice(0, 6) };
    const firstBranch = store.change({ type: "create-branch", anchor: firstAnchor }).branches[0];
    store.saveReply(firstBranch.id, "旧问题", "旧回答");
    const note = store.change({ type: "add-note", anchor: firstAnchor, text: "被选择的记忆" }).notes[0];
    store.change({ type: "pin-note", id: note.id });
    const secondBranch = store.change({ type: "create-branch", anchor: secondAnchor }).branches[1];
    store.change({ type: "memory", id: secondBranch.id, noteId: note.id, enabled: true });
    const state = store.change({
      type: "edit-document", title: "标题", blocks: [{ id: second.id, text: "增加前缀。" + second.text }]
    });
    const branch = state.branches[1];
    assert.equal(findAnchor(state.blocks[1].text, branch.anchor), 5);
    assert.deepEqual(turnInput(state, branch, "新问题"), {
      context: second.text, memories: ["被选择的记忆"], history: [], question: "新问题"
    });
  } finally {
    store.close();
  }
});

test("a member's own name is removed from the start of its answer", async () => {
  const { stripSpeaker } = await import("./notebook.mjs");
  assert.equal(stripSpeaker("claude2：1+1 等于 2。", "claude2"), "1+1 等于 2。");
  assert.equal(stripSpeaker("【claude2】\n答案是 2", "claude2"), "答案是 2");
  assert.equal(stripSpeaker("**Claude2**: 好的", "claude2"), "好的");
  assert.equal(stripSpeaker("claude1 说得对", "claude2"), "claude1 说得对");
});

test("the main chat can use only chosen messages as context, plus everything after the choice", () => {
  const store = new NotebookStore(":memory:");
  try {
    store.saveReply(null, "第一问", "第一答");
    store.saveReply(null, "第二问", "第二答");
    const second = store.read().blocks.find((block) => block.text === "第二问");
    store.change({ type: "set-context", ids: [second.id] });
    // Only the second question was chosen: not its answer, and nothing from the first turn.
    assert.deepEqual(mainHistory(store.read()).map((turn) => [turn.question, turn.answer]), [["第二问", ""]]);
    store.saveReply(null, "第三问", "第三答");
    assert.deepEqual(mainHistory(store.read()).map((turn) => turn.question), ["第二问", "第三问"]);
    assert.throws(() => store.change({ type: "set-context", ids: ["missing"] }), /已改变/);
    store.change({ type: "clear-context" });
    assert.equal(mainHistory(store.read()).length, 3);
  } finally {
    store.close();
  }
});

test("a chat gets its own members, several of them on one account with different role prompts", async () => {
  const { buildPrompt } = await import("./codex.mjs");
  const store = new NotebookStore(":memory:");
  try {
    const profiles = new Profiles(store.db);
    const id = store.read().id;
    const { state, result: added } = store.changeMembers(id, { type: "member-add", profileId: "claude-native",
      name: "审稿人", prompt: "你只指出漏洞。" }, profiles.read());
    assert.deepEqual(state.members.map((member) => member.name), ["gpt1", "claude1", "审稿人"]);
    assert.equal(added.profileId, "claude-native");
    assert.equal(profiles.read().members.length, 2);
    const other = store.create("另一份").state;
    assert.equal(other.members, undefined);
    assert.throws(() => store.changeMembers(id, { type: "member-update", id: added.id, prompt: "x".repeat(4001) },
      profiles.read()), /4000/);
    const prompt = buildPrompt({ context: "", memories: [], history: [], question: "看看这个论证",
      persona: { name: "审稿人", provider: "Claude", others: ["gpt1"], round: [], role: added.prompt } });
    assert.match(prompt, /^你的身份\n你的角色设定[^\n]*\n你只指出漏洞。/);
  } finally {
    store.close();
  }
});

test("Antigravity's quota report becomes usage bars", async () => {
  const { parseQuota } = await import("./antigravity.mjs");
  const items = parseQuota("Gemini Models\tWeekly Limit Remaining\t99%\t2026-11-28T09:43:52Z\n" +
    "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-21T14:45:12Z\nnoise line\n");
  assert.deepEqual(items.map(({ label, usedPercent }) => [label, usedPercent]),
    [["Gemini 模型 · 每周", 1], ["Claude/GPT 模型 · 5 小时", 0]]);
  assert.equal(items[0].resetsAt, Date.parse("2026-11-28T09:43:52Z"));
});

test("a member moved to another app's account trades its default avatar for that app's", () => {
  const store = new NotebookStore(":memory:");
  try {
    const profiles = new Profiles(store.db);
    const claude = profiles.read().members.find((member) => member.name === "claude1");
    assert.equal(claude.avatar, "fox");
    profiles.change({ type: "member-update", id: claude.id, profileId: "gemini-native" });
    assert.equal(profiles.read().members.find((member) => member.id === claude.id).avatar, "owl");
    const gpt = profiles.read().members.find((member) => member.name === "gpt1");
    profiles.change({ type: "member-update", id: gpt.id, avatar: "bear" });
    profiles.change({ type: "member-update", id: gpt.id, profileId: "claude-native" });
    assert.equal(profiles.read().members.find((member) => member.id === gpt.id).avatar, "bear");
  } finally {
    store.close();
  }
});

test("any message can become a note block or a margin annotation, and annotations join context only when chosen", () => {
  const store = new NotebookStore(":memory:");
  try {
    const image = { id: "11111111-2222-4333-8444-555555555557", extension: ".png", name: "截图.png", size: 3 };
    store.saveReply(null, "看看这张图", "第一答", { provider: "claude", memberName: "claude1" }, [image]);
    store.saveReply(null, "第二问", "第二答", { provider: "gpt", memberName: "gpt1" });
    let state = store.read();
    const question = state.blocks.find((block) => block.text === "看看这张图");
    store.change({ type: "convert-message", ids: [question.id] });
    state = store.read();
    const after = state.blocks.slice(state.blocks.findIndex((block) => block.id === question.id) + 1);
    assert.deepEqual(after.slice(0, 2).map((block) => [block.kind, block.noteType ?? "text", block.text]),
      [["paragraph", "image", "截图.png"], ["paragraph", "text", "看看这张图"]]);
    assert.equal(state.blocks.find((block) => block.id === question.id).removed, true);
    assert.equal(state.blocks.find((block) => block.id === question.id).attachments, undefined);
    assert.equal(allAttachmentRefs(state).filter((ref) => ref.id === image.id).length, 1);
    assert.equal(mainHistory(state)[0].question, "");
    assert.throws(() => store.change({ type: "convert-message", ids: [after[1].id] }), /已经是笔记块/);

    const reply = state.blocks.find((block) => block.text === "第二答");
    store.change({ type: "message-to-annotation", ids: [reply.id] });
    state = store.read();
    const note = state.notes.at(-1);
    assert.equal(note.text, "第二答");
    assert.equal(note.author, "gpt1 的回答");
    assert.equal(state.blocks.find((block) => block.id === note.anchor.blockId).text, "第二问");
    assert.ok(state.blocks.find((block) => block.id === reply.id).removed);
    assert.ok(!mainHistory(state).some((turn) => turn.answer.includes("第二答")));
    assert.doesNotMatch(turnInput(state, null, "继续").context, /选入的批注/);

    store.change({ type: "set-context", ids: null, noteIds: [note.id] });
    assert.match(turnInput(store.read(), null, "继续").context, /选入的批注：\n- gpt1 的回答（标在「第二问」旁）：第二答/);
    assert.equal(mainHistory(store.read()).length, 2);
    store.change({ type: "set-context", ids: [], noteIds: [] });
    assert.equal(mainHistory(store.read()).length, 0);
    store.change({ type: "set-context", ids: null, noteIds: [] });
    assert.equal(store.read().context, undefined);
    const question2 = store.read().blocks.find((block) => block.text === "第二问");
    store.change({ type: "message-to-annotation", ids: [question2.id] });
    assert.equal(store.read().notes.at(-1).author, "我的消息");
  } finally {
    store.close();
  }
});

test("a message moved to the margin can hang on a passage the user picked", () => {
  const store = new NotebookStore(":memory:");
  try {
    store.saveReply(null, "第一问", "这是一段很长的回答，其中关键句在这里。");
    store.saveReply(null, "第二问", "补充说明");
    const state = store.read();
    const target = state.blocks.find((block) => block.text.startsWith("这是一段"));
    const moving = state.blocks.find((block) => block.text === "补充说明");
    const start = target.text.indexOf("关键句");
    store.change({ type: "message-to-annotation", ids: [moving.id], anchor: { blockId: target.id, start, quote: "关键句" } });
    assert.deepEqual(store.read().notes.at(-1).anchor, { blockId: target.id, start, quote: "关键句" });
    const question = store.read().blocks.find((block) => block.text === "第二问");
    assert.throws(() => store.change({ type: "message-to-annotation", ids: [question.id],
      anchor: { blockId: question.id, start: 0, quote: "第二" } }), /自己/);
    assert.throws(() => store.change({ type: "message-to-annotation", ids: [question.id],
      anchor: { blockId: target.id, start: 0, quote: "不存在的话" } }), /选区已改变/);
  } finally {
    store.close();
  }
});
