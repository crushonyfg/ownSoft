// To-dos: something to do (picked from a message or typed in), optionally on a date, optionally
// repeating, optionally done by a member of the chat (the AI) when the time comes. Each to-do is
// a node of the chat tree: it has a chat of its own (key "todo:<id>") that begins with the message
// it came from, and each time the AI works on it a question and answer are added there.
export const repeatUnits = { day: "天", week: "周", month: "个月" };
export const todoStatuses = { open: "待办", ran: "AI 已执行，待确认", done: "已完成" };

// { every: 1..365, unit: "day" | "week" | "month" } or null (no repeat).
export function normalizeRepeat(repeat) {
  if (!repeat || typeof repeat !== "object") return null;
  const every = Math.round(Number(repeat.every));
  if (!repeatUnits[repeat.unit] || !Number.isFinite(every) || every < 1 || every > 365) return null;
  return { every, unit: repeat.unit };
}

export function repeatLabel(repeat) {
  const value = normalizeRepeat(repeat);
  if (!value) return "不重复";
  if (value.every === 1) return { day: "每天", week: "每周", month: "每月" }[value.unit];
  return `每 ${value.every} ${repeatUnits[value.unit]}`;
}

function add(time, { every, unit }) {
  const date = new Date(time);
  if (unit === "day") date.setDate(date.getDate() + every);
  else if (unit === "week") date.setDate(date.getDate() + 7 * every);
  else {
    // The same day of the month, or the month's last day when it is shorter (31 Jan → 28/29 Feb).
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + every);
    date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  }
  return date.getTime();
}

// The next time after `now` on the schedule starting at `from` (missed times are skipped: a to-do
// that was due while the app was closed runs once, then continues on its schedule).
export function nextOccurrence(from, repeat, now = Date.now()) {
  const value = normalizeRepeat(repeat);
  if (!value || !Number.isFinite(from)) return null;
  let next = from;
  for (let guard = 0; next <= now && guard < 100_000; guard += 1) next = add(next, value);
  return next;
}

const stamp = (time) => new Date(time).toLocaleString("zh-CN", { hour12: false });

// What the AI is asked when the time comes. Its chat already holds the message the to-do came
// from (context) and earlier runs; it can look further with its tools (the ownsoft notebook tools).
export function todoPrompt(todo, now = Date.now()) {
  return [
    `这是一个定时待办，现在（${stamp(now)}）到了执行时间，请执行它。`,
    `待办内容：\n${todo.text}`,
    todo.quote && `它来自这段选中的文字：「${todo.quote}」`,
    `创建于 ${stamp(todo.createdAt)}${todo.repeat ? `，${repeatLabel(todo.repeat)}重复` : ""}${todo.runs ? `，这是第 ${todo.runs + 1} 次执行` : ""}。`,
    "默认的上下文是这条待办来自的那条消息（这段会话开头）和之前几次执行的记录；需要更多信息时，可以用 ownsoft 笔记本工具搜索、查看其他会话、文档、PDF 审阅和批注，也可以用你自己的工具（例如上网搜索）。",
    `这条待办的 ID 是 ${todo.id}。如果发现现在还不是时候、需要过一段时间再看，或者需要分出后续的事，请直接用 ownsoft 的 update_todo（给这一条换个时间，例如 after: { amount: 3, unit: "day" }）或 add_todo（新的待办，传 fromTodoId 让它沿用同一条来源消息）自己安排，并在回答里说明安排了什么、为什么。`,
    "完成后先写结论，再列出依据和建议的下一步；如果条件还不满足或需要我决定，直接说明。"
  ].filter(Boolean).join("\n\n");
}
