import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commentInput, findAnchor, mainHistory, noteOrigin, turnInput } from "./notebook.mjs";
import { NotebookStore } from "./store.mjs";
import { Profiles } from "./profiles.mjs";

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

test("providers remember their account and each account remembers its models and efforts", () => {
  const store = new NotebookStore(":memory:");
  try {
    const profiles = new Profiles(store.db);
    profiles.change({ type: "model", model: "gpt-first" });
    profiles.change({ type: "effort", effort: "low" });
    profiles.change({ type: "model", model: "gpt-second" });
    profiles.change({ type: "effort", effort: "high" });
    profiles.change({ type: "provider", provider: "claude" });
    profiles.change({ type: "add", name: "工作" });
    const work = profiles.get();
    assert.equal(work.native, false);
    profiles.change({ type: "model", model: "sonnet" });
    profiles.change({ type: "effort", effort: "medium" });
    profiles.change({ type: "provider", provider: "gpt" });
    profiles.change({ type: "model", model: "gpt-first" });
    assert.equal(profiles.get().efforts["gpt-first"], "low");
    assert.equal(profiles.get().efforts["gpt-second"], "high");
    profiles.change({ type: "provider", provider: "claude" });
    assert.equal(profiles.get().id, work.id);
    assert.equal(profiles.get().efforts.sonnet, "medium");
    assert.equal(new Profiles(store.db).get().model, "sonnet");
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
