// To-dos and their calendar (data: todos.mjs / store; the AI's runs: main.mjs). A to-do is a node of
// the chat tree: its chat (shown here with the app's one chat component) begins with the message
// it came from, and every run of the AI adds to it.
import { embedChat } from "./embedded-chat.mjs";

const repeatChoices = [["", "不重复"], ["1:day", "每天"], ["1:week", "每周"], ["2:week", "每两周"], ["1:month", "每月"],
  ["3:month", "每季度"], ["custom", "自定义…"]];
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const units = { day: "天", week: "周", month: "个月" };

function create(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}
function control(text, className = "", title = "") {
  const element = create("button", className, text);
  element.type = "button";
  if (title) element.title = title;
  return element;
}
const pad = (value) => String(value).padStart(2, "0");
const localInput = (time) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const when = (time) => {
  const date = new Date(time);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "今天" : `${date.getMonth() + 1}月${date.getDate()}日`} ${pad(date.getHours())}:${pad(date.getMinutes())}` +
    (date.getFullYear() !== today.getFullYear() ? ` · ${date.getFullYear()}` : "");
};
const repeatText = (repeat) => !repeat ? "" : repeat.every === 1 ? { day: "每天", week: "每周", month: "每月" }[repeat.unit]
  : `每 ${repeat.every} ${units[repeat.unit]}`;
const dayKey = (time) => { const date = new Date(time); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

// The times a repeating to-do falls on between start and end (for the calendar).
function occurrences(todo, start, end) {
  if (!todo.dueAt) return [];
  if (!todo.repeat) return todo.dueAt >= start && todo.dueAt < end ? [todo.dueAt] : [];
  const times = [];
  let time = todo.dueAt;
  for (let guard = 0; time < end && guard < 400; guard += 1) {
    if (time >= start) times.push(time);
    const date = new Date(time);
    if (todo.repeat.unit === "day") date.setDate(date.getDate() + todo.repeat.every);
    else if (todo.repeat.unit === "week") date.setDate(date.getDate() + 7 * todo.repeat.every);
    else date.setMonth(date.getMonth() + todo.repeat.every);
    time = date.getTime();
  }
  return times;
}

// ctx: { notify, members() → [{ id, name }], defaultMemberId(), openSource(todo), showView() }
export function setupTodos(api, ctx) {
  const get = (id) => document.getElementById(id);
  let todos = [];
  let selected = null;
  let mode = "list";
  try { mode = localStorage.getItem("todo-mode") === "calendar" ? "calendar" : "list"; } catch {}
  let month = new Date();
  month.setDate(1);
  let showDone = false;

  // ---- the add / edit dialog ----------------------------------------------------------------------
  const dialog = create("dialog", "todo-dialog");
  const form = create("form", "todo-form");
  const heading = create("h2", "", "加入待办");
  const source = create("p", "todo-source muted");
  const text = create("textarea", "todo-text");
  text.rows = 4;
  text.maxLength = 20000;
  text.placeholder = "要做的事，例如：一周后看看纳指是否出现超跌反弹，对比当时的判断";
  const dueRow = create("label", "todo-row");
  const due = create("input");
  due.type = "datetime-local";
  const noDate = create("input");
  noDate.type = "checkbox";
  const noDateLabel = create("label", "todo-inline");
  noDateLabel.append(noDate, document.createTextNode("不设日期"));
  dueRow.append(create("span", "", "时间"), due, noDateLabel);
  const repeatRow = create("label", "todo-row");
  const repeat = create("select");
  for (const [value, label] of repeatChoices) repeat.append(new Option(label, value));
  const every = create("input");
  every.type = "number";
  every.min = 1;
  every.max = 365;
  every.value = 3;
  const unit = create("select");
  for (const [value, label] of Object.entries(units)) unit.append(new Option(label, value));
  const custom = create("span", "todo-inline");
  custom.append(document.createTextNode("每"), every, unit);
  repeatRow.append(create("span", "", "重复"), repeat, custom);
  const memberRow = create("label", "todo-row");
  const member = create("select");
  memberRow.append(create("span", "", "执行成员"), member);
  const aiRow = create("label", "todo-inline todo-ai");
  const ai = create("input");
  ai.type = "checkbox";
  aiRow.append(ai, document.createTextNode("到时间让 AI 去做"));
  const hint = create("p", "todo-hint muted",
    "默认的上下文是这条待办来自的那条消息；AI 也可以用 ownsoft 笔记本工具查看其他会话、文档和批注。结果会写进这条待办自己的会话，并发系统通知。");
  const actions = create("div", "dialog-actions");
  const cancel = control("取消");
  const save = control("保存", "primary");
  save.type = "submit";
  actions.append(cancel, save);
  form.append(heading, source, text, dueRow, repeatRow, memberRow, aiRow, hint, actions);
  dialog.append(form);
  document.body.append(dialog);
  let editing = null;

  const sync = () => {
    due.disabled = noDate.checked;
    custom.hidden = repeat.value !== "custom";
    repeat.disabled = noDate.checked;
    member.disabled = !ai.checked;
  };
  for (const input of [noDate, repeat, ai]) input.addEventListener("change", sync);
  cancel.addEventListener("click", () => dialog.close());

  // fields: { text, quote, chatId, blockId, chatTitle } for a new one, or an existing to-do.
  function openDialog(fields = {}) {
    editing = fields.id ? fields : null;
    heading.textContent = editing ? "编辑待办" : "加入待办";
    source.textContent = fields.chatId ? `来自「${fields.chatTitle || "这段会话"}」${fields.quote ? `：「${fields.quote.slice(0, 120)}」` : "的这条消息"}` : "不属于任何会话";
    text.value = editing ? fields.text : fields.text ?? fields.quote ?? "";
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    due.value = localInput(editing?.dueAt || tomorrow.getTime());
    noDate.checked = Boolean(editing && !editing.dueAt);
    const current = editing?.repeat ? `${editing.repeat.every}:${editing.repeat.unit}` : "";
    repeat.value = repeatChoices.some(([value]) => value === current) ? current : "custom";
    if (repeat.value === "custom" && editing?.repeat) { every.value = editing.repeat.every; unit.value = editing.repeat.unit; }
    member.replaceChildren(...ctx.members().map((item) => new Option(item.name, item.id)));
    member.value = editing?.memberId || ctx.defaultMemberId() || member.options[0]?.value || "";
    ai.checked = editing ? editing.ai : true;
    dialog.dataset.chatId = fields.chatId || "";
    dialog.dataset.blockId = fields.blockId || "";
    dialog.dataset.quote = fields.quote || "";
    sync();
    dialog.showModal();
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const [count, kind] = repeat.value === "custom" ? [every.value, unit.value] : repeat.value.split(":");
    const fields = {
      text: text.value, dueAt: noDate.checked ? null : new Date(due.value).getTime(),
      repeat: noDate.checked || !repeat.value ? null : { every: Number(count), unit: kind },
      memberId: member.value || null, ai: ai.checked
    };
    if (!editing) Object.assign(fields, { chatId: dialog.dataset.chatId || null, blockId: dialog.dataset.blockId || null,
      quote: dialog.dataset.quote || "" });
    api.saveTodo(fields, editing?.id).then((todo) => {
      dialog.close();
      selected = todo.id;
      ctx.notify(editing ? "待办已更新。" : `已加入待办${todo.dueAt ? `，${when(todo.dueAt)}${todo.ai ? " 由 AI 执行" : ""}` : ""}。`);
      return render();
    }).catch((error) => ctx.notify(error.message));
  });

  // ---- the page -----------------------------------------------------------------------------------
  const view = get("todo-view");
  if (!view) return { openDialog, render: async () => {}, select: () => {}, refreshBadge: async () => {} };
  const list = get("todo-list");
  const calendar = get("todo-calendar");
  const detail = get("todo-detail");
  get("todo-new").addEventListener("click", () => openDialog({}));
  for (const button of view.querySelectorAll("[data-todo-mode]")) {
    button.addEventListener("click", () => {
      mode = button.dataset.todoMode;
      try { localStorage.setItem("todo-mode", mode); } catch {}
      paint();
    });
  }

  async function render() {
    try {
      todos = await api.todos();
    } catch (error) {
      ctx.notify(error.message);
      return;
    }
    badge();
    if (!view.hidden) paint();
  }

  function badge() {
    const now = Date.now();
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const count = todos.filter((todo) => todo.status === "ran" || (todo.status === "open" && todo.dueAt && todo.dueAt <= endOfDay.getTime())).length;
    const element = get("todo-badge");
    if (element) {
      element.textContent = count ? String(count) : "";
      element.hidden = !count;
    }
    void now;
  }

  function status(todo) {
    if (todo.running) return "执行中…";
    if (todo.status === "done") return "已完成";
    if (todo.status === "ran") return "AI 已执行，待你确认";
    if (todo.lastError) return `上次失败：${todo.lastError}`;
    if (!todo.dueAt) return todo.ai ? "未设时间" : "";
    return todo.dueAt < Date.now() ? "已到期" : "";
  }

  function item(todo) {
    const row = create("div", `todo-item is-${todo.status}${todo.running ? " is-running" : ""}${todo.id === selected ? " is-selected" : ""}`);
    const check = create("input");
    check.type = "checkbox";
    check.checked = todo.status === "done";
    check.title = todo.status === "done" ? "重新打开" : "标记完成";
    check.addEventListener("click", (event) => {
      event.stopPropagation();
      api.saveTodo({ status: check.checked ? "done" : "open" }, todo.id).then(render).catch((error) => ctx.notify(error.message));
    });
    const body = create("div", "todo-item-body");
    body.append(create("div", "todo-item-text", todo.text));
    const meta = [todo.dueAt ? when(todo.dueAt) : "", repeatText(todo.repeat), todo.ai ? `AI：${ctx.members().find((m) => m.id === todo.memberId)?.name || "默认成员"}` : "",
      todo.chatTitle ? `来自「${todo.chatTitle}」` : "", status(todo)].filter(Boolean).join(" · ");
    body.append(create("div", "todo-item-meta", meta));
    row.append(check, body);
    row.addEventListener("click", () => select(todo.id));
    return row;
  }

  function paintList() {
    const now = Date.now();
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const groups = [
      ["AI 已执行，待你确认", todos.filter((todo) => todo.status === "ran")],
      ["已到期", todos.filter((todo) => todo.status === "open" && todo.dueAt && todo.dueAt < now)],
      ["今天", todos.filter((todo) => todo.status === "open" && todo.dueAt && todo.dueAt >= now && todo.dueAt <= endOfDay.getTime())],
      ["之后", todos.filter((todo) => todo.status === "open" && todo.dueAt && todo.dueAt > endOfDay.getTime())],
      ["没有时间", todos.filter((todo) => todo.status === "open" && !todo.dueAt)]
    ];
    const parts = [];
    for (const [title, items] of groups) {
      if (!items.length) continue;
      parts.push(create("h3", "todo-group", `${title} · ${items.length}`), ...items.map(item));
    }
    const done = todos.filter((todo) => todo.status === "done");
    if (done.length) {
      const toggle = control(`${showDone ? "▾" : "▸"} 已完成 · ${done.length}`, "todo-group-toggle");
      toggle.addEventListener("click", () => { showDone = !showDone; paint(); });
      parts.push(toggle, ...(showDone ? done.map(item) : []));
    }
    if (!parts.length) parts.push(create("p", "todo-empty muted", "还没有待办。在任意消息里选中文字，点小工具条上的「加入待办」；或点右上角「＋ 新待办」。"));
    list.replaceChildren(...parts);
  }

  function paintCalendar() {
    const start = new Date(month);
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    const head = create("div", "todo-calendar-head");
    const previous = control("‹", "", "上个月");
    const next = control("›", "", "下个月");
    const today = control("本月");
    previous.addEventListener("click", () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); paint(); });
    next.addEventListener("click", () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); paint(); });
    today.addEventListener("click", () => { month = new Date(); month.setDate(1); paint(); });
    head.append(previous, create("strong", "", `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`), next, today);
    const grid = create("div", "todo-calendar-grid");
    for (const day of weekdays) grid.append(create("div", "todo-weekday", day));
    const offset = (start.getDay() + 6) % 7;
    const cellStart = new Date(start);
    cellStart.setDate(1 - offset);
    const byDay = new Map();
    const from = cellStart.getTime();
    const until = new Date(cellStart.getFullYear(), cellStart.getMonth(), cellStart.getDate() + 42).getTime();
    for (const todo of todos) {
      if (todo.status === "done" && !showDone) continue;
      for (const time of occurrences(todo, from, until)) {
        const key = dayKey(time);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push({ todo, time });
      }
    }
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(cellStart.getFullYear(), cellStart.getMonth(), cellStart.getDate() + index);
      const cell = create("div", `todo-day${date.getMonth() !== month.getMonth() ? " is-other" : ""}${date.toDateString() === new Date().toDateString() ? " is-today" : ""}`);
      cell.append(create("span", "todo-day-number", String(date.getDate())));
      for (const { todo, time } of (byDay.get(dayKey(date.getTime())) || []).sort((a, b) => a.time - b.time)) {
        const chip = control(`${pad(new Date(time).getHours())}:${pad(new Date(time).getMinutes())} ${todo.text}`,
          `todo-chip is-${todo.status}${todo.id === selected ? " is-selected" : ""}`, todo.text);
        chip.addEventListener("click", () => select(todo.id));
        cell.append(chip);
      }
      // A new to-do on this day (no source message).
      cell.addEventListener("dblclick", (event) => {
        if (event.target !== cell && !event.target.classList.contains("todo-day-number")) return;
        const at = new Date(date);
        at.setHours(9, 0, 0, 0);
        openDialog({});
        due.value = localInput(at.getTime());
      });
      grid.append(cell);
    }
    calendar.replaceChildren(head, grid, create("p", "todo-hint muted", "双击某一天新建待办；重复的待办会显示在它之后的每一次时间上。"));
  }

  function paint() {
    for (const button of view.querySelectorAll("[data-todo-mode]")) button.setAttribute("aria-pressed", String(button.dataset.todoMode === mode));
    get("todo-count").textContent = `${todos.filter((todo) => todo.status !== "done").length} 条未完成 · ${todos.filter((todo) => todo.ai && todo.status === "open" && todo.dueAt).length} 条等 AI 执行`;
    list.hidden = mode !== "list";
    calendar.hidden = mode !== "calendar";
    if (mode === "list") paintList();
    else paintCalendar();
    paintDetail();
  }

  function paintDetail() {
    const todo = todos.find((item) => item.id === selected);
    detail.hidden = !todo;
    get("todo-split").hidden = !todo;
    if (!todo) return;
    get("todo-detail-text").textContent = todo.text;
    get("todo-detail-meta").textContent = [todo.dueAt ? when(todo.dueAt) : "未设时间", repeatText(todo.repeat),
      todo.ai ? `由 ${ctx.members().find((m) => m.id === todo.memberId)?.name || "默认成员"} 执行` : "不让 AI 执行",
      todo.runs ? `已执行 ${todo.runs} 次${todo.lastRunAt ? `，上次 ${when(todo.lastRunAt)}` : ""}` : "", status(todo)].filter(Boolean).join(" · ");
    const actions = get("todo-detail-actions");
    const button = (label, run, className = "") => {
      const element = control(label, className);
      element.addEventListener("click", () => Promise.resolve(run()).catch((error) => ctx.notify(error.message)));
      return element;
    };
    actions.replaceChildren(
      button(todo.running ? "执行中…" : "让 AI 现在执行", async () => { await api.runTodo(todo.id); ctx.notify("AI 开始执行这条待办，结果会写在下面的会话里。"); await render(); }, "primary"),
      button("编辑", () => openDialog(todo)),
      button(todo.status === "done" ? "重新打开" : "标记完成", async () => { await api.saveTodo({ status: todo.status === "done" ? "open" : "done" }, todo.id); await render(); }),
      ...(todo.chatId ? [button("打开来源", () => ctx.openSource(todo))] : []),
      button("删除", async () => {
        if (!window.confirm("删除这条待办和它的执行记录？")) return;
        await api.deleteTodo(todo.id);
        selected = null;
        await render();
      }));
    actions.querySelector(".primary").disabled = Boolean(todo.running);
    const box = get("todo-chat");
    if (box.dataset.todoId !== todo.id) {
      box.dataset.todoId = todo.id;
      box.replaceChildren();
      api.childChatId({ kind: "todo", itemId: todo.id }).then((id) => {
        if (box.dataset.todoId === todo.id) embedChat(box, id, { label: "待办的会话" });
      }).catch((error) => ctx.notify(error.message));
    }
  }

  function select(id) {
    selected = id;
    paint();
  }

  api.onTodosChanged?.(() => void render());
  api.onTodoOpen?.((id) => {
    selected = id;
    ctx.showView();
    void render();
  });
  void render();
  return { openDialog, render, select, refreshBadge: render };
}
