import assert from "node:assert/strict";
import { test } from "node:test";
import { NotebookStore } from "./store.mjs";
import { nextOccurrence, normalizeRepeat, repeatLabel, todoPrompt } from "./todos.mjs";

const claude = { provider: "claude", model: "", effort: "", memberId: "m-1", memberName: "claude1", avatar: "fox" };
const at = (text) => new Date(text).getTime();

test("repeats: days, weeks, months (keeping the day, or the month's last day), skipping missed times", () => {
  assert.equal(normalizeRepeat({ every: 0, unit: "day" }), null);
  assert.deepEqual(normalizeRepeat({ every: "2", unit: "week" }), { every: 2, unit: "week" });
  assert.equal(repeatLabel({ every: 1, unit: "month" }), "每月");
  assert.equal(repeatLabel({ every: 3, unit: "day" }), "每 3 天");
  assert.equal(nextOccurrence(at("2026-01-31T09:00"), { every: 1, unit: "month" }, at("2026-01-31T10:00")), at("2026-02-28T09:00"));
  assert.equal(nextOccurrence(at("2026-11-01T09:00"), { every: 1, unit: "week" }, at("2026-11-20T00:00")), at("2026-11-22T09:00"));
  assert.equal(nextOccurrence(at("2026-11-01T09:00"), null, at("2026-11-20T00:00")), null);
  const prompt = todoPrompt({ text: "看看纳指是否反弹", quote: "超跌反弹", createdAt: at("2026-11-01T09:00"), runs: 2,
    repeat: { every: 1, unit: "week" } }, at("2026-11-22T09:00"));
  assert.match(prompt, /看看纳指是否反弹/);
  assert.match(prompt, /每周重复，这是第 3 次执行/);
  assert.match(prompt, /ownsoft/);
});

test("a to-do from a message has its own chat, beginning with that message; runs move it along", () => {
  const store = new NotebookStore(":memory:");
  try {
    const state = store.saveReply(null, "问题", "下周初出现超跌反弹的概率超过 70%。", claude);
    const reply = state.blocks.find((block) => block.kind === "reply");
    const todo = store.saveTodo({ text: "一周后看看是否反弹", chatId: state.id, blockId: reply.id, quote: "超跌反弹",
      dueAt: at("2026-11-29T09:00"), memberId: "m-1" });
    assert.deepEqual([todo.status, todo.chatTitle, todo.ai], ["open", state.title, true]);
    const chatId = store.openChildChat({ kind: "todo", itemId: todo.id });
    const first = store.read(chatId).blocks[0];
    assert.deepEqual([first.noteType, first.marks[0].quote], ["source", "超跌反弹"]);
    // Saving the chat it came from keeps the to-do's chat.
    store.change({ type: "edit-document", title: "改名", messages: [] }, state.id);
    assert.ok(store.read(chatId));
    // Due: only once its time has come.
    assert.equal(store.dueTodos(at("2026-11-28T09:00")).length, 0);
    assert.equal(store.dueTodos(at("2026-11-29T09:01"))[0].id, todo.id);
    assert.equal(store.nextTodoDue(), at("2026-11-29T09:00"));
    // A one-off waits for the user after a run; a repeating one moves to its next time.
    assert.equal(store.finishTodoRun(todo.id, { ok: true }, at("2026-11-29T09:01")).status, "ran");
    assert.equal(store.dueTodos(at("2026-12-01T00:00")).length, 0);
    const weekly = store.saveTodo({ text: "每周复盘", chatId: state.id, dueAt: at("2026-11-23T09:00"), repeat: { every: 1, unit: "week" } });
    const after = store.finishTodoRun(weekly.id, { ok: true }, at("2026-11-23T09:02"));
    assert.deepEqual([after.status, after.dueAt, after.runs], ["open", at("2026-11-30T09:00"), 1]);
    // A failed one-off is tried again later.
    const failing = store.saveTodo({ text: "会失败", dueAt: at("2026-11-23T09:00") });
    const retry = store.finishTodoRun(failing.id, { ok: false, error: "没登录" }, at("2026-11-23T09:00"));
    assert.deepEqual([retry.status, retry.lastError, retry.dueAt], ["open", "没登录", at("2026-11-23T09:30")]);
    // Editing the date of a run one reopens it; deleting removes its chat.
    assert.equal(store.saveTodo({ dueAt: at("2026-12-06T09:00") }, todo.id).status, "open");
    store.deleteTodo(todo.id);
    assert.equal(store.childChat(`todo:${todo.id}`), null);
    assert.throws(() => store.saveTodo({ text: "x", repeat: { every: 1, unit: "day" } }), /开始日期/);
  } finally {
    store.close();
  }
});

test("the AI can add, reschedule and finish to-dos through the notebook tools", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { NotebookTools, todoTime } = await import("./notebook-tools.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ownsoft-todo-tools-"));
  const tools = new NotebookTools(dir);
  try {
    const now = at("2026-11-23T10:00");
    assert.equal(todoTime({ after: { amount: 3, unit: "day" } }, now), at("2026-11-26T10:00"));
    assert.equal(todoTime({ dueAt: "2026-12-01 09:30" }), at("2026-12-01T09:30"));
    assert.equal(todoTime({}), undefined);
    assert.throws(() => todoTime({ dueAt: "下周" }), /日期时间/);
    const state = tools.store.saveReply(null, "问题", "下周初出现超跌反弹的概率超过 70%。", claude);
    const reply = state.blocks.find((block) => block.kind === "reply");
    const first = tools.addTodo({ text: "看看是否反弹", dueAt: "2026-11-30T09:00", notebookId: state.id, messageId: reply.id, quote: "超跌反弹" });
    // A follow-up keeps the same source message.
    const followUp = tools.addTodo({ text: "再看一次成交量", after: { amount: 2, unit: "week" }, fromTodoId: first.id });
    assert.deepEqual([followUp.notebookId, followUp.messageId, followUp.quote], [state.id, reply.id, "超跌反弹"]);
    assert.deepEqual(tools.listTodos({ status: "open" }).map((todo) => todo.text), ["看看是否反弹", "再看一次成交量"]);
    // Rescheduling one the AI already ran puts it back on the list.
    tools.store.finishTodoRun(first.id, { ok: true }, at("2026-11-30T09:01"));
    const moved = tools.updateTodo({ todoId: first.id, dueAt: "2026-12-03T09:00" });
    assert.deepEqual([moved.status, moved.dueLocal.startsWith("2026/12/3")], ["open", true]);
    assert.equal(tools.updateTodo({ todoId: followUp.id, status: "done" }).status, "done");
    // Rescheduled by the AI while it was being done: the new time stands when the run ends.
    const running = tools.store.todo(first.id);
    tools.updateTodo({ todoId: first.id, after: { amount: 3, unit: "day" } });
    const finished = tools.store.finishTodoRun(first.id, { ok: true, dueAtStart: running.dueAt }, Date.now());
    assert.equal(finished.status, "open");
    assert.ok(finished.dueAt > Date.now());
    assert.match(todoPrompt(tools.store.todo(first.id)), new RegExp(`待办的 ID 是 ${first.id}[^]*update_todo`));
  } finally {
    tools.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
