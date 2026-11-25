// Private side conversations with single members, as small windows over the chat.
// A row of avatars on the right edge ("chat heads") lists them: a spinning ring while a member is
// answering, a green count once new answers arrive. Windows tile themselves (about a quarter of
// the screen each) or can be moved, resized and snapped like windows on a desktop.
// Each conversation sees the chat's shared notes and public messages; nobody else sees it until
// it is published into the chat.
import { createComposer } from "./chat-composer.mjs";
import { chatTurn, toolDetails } from "./comment-chat.mjs";
import { renderMarkdown } from "./markdown-dom.mjs";
import { pixelAvatar } from "./pixel-avatars.mjs";
import { collapseWorkProgress, updateThinking } from "./work-progress.mjs";
import { embedChat } from "./embedded-chat.mjs";

const get = (id) => document.getElementById(id);
const create = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};
const button = (text, className = "", title = "") => {
  const control = create("button", className, text);
  control.type = "button";
  if (title) {
    control.title = title;
    control.setAttribute("aria-label", title);
  }
  return control;
};
const stored = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(`ai-notebook:${key}`)) ?? fallback; } catch { return fallback; }
};
const store = (key, value) => {
  try { localStorage.setItem(`ai-notebook:${key}`, JSON.stringify(value)); } catch {}
};

// Re-rendering moves elements; the box being typed in keeps its focus and caret.
export function keepFocus(task) {
  const active = document.activeElement;
  const caret = active?.matches?.("textarea, input[type=text]") ? [active.selectionStart, active.selectionEnd] : null;
  task();
  if (active && active !== document.activeElement && active.isConnected) {
    active.focus({ preventScroll: true });
    if (caret) active.setSelectionRange(...caret);
  }
}

const snaps = {
  "left-half": "左半屏", "right-half": "右半屏", "top-right": "右上 1/4", "bottom-right": "右下 1/4",
  "top-left": "左上 1/4", "bottom-left": "左下 1/4", maximize: "最大化"
};

export function setupThreads(api, ctx) {
  const dock = get("thread-dock");
  const layer = get("thread-windows");
  const entries = new Map();
  const running = new Map();
  let stack = 40;
  let menuOpen = false;

  const threads = () => ctx.notebook()?.threads || [];
  const threadById = (id) => threads().find((item) => item.id === id);
  const memberOf = (thread) => ctx.memberById(thread?.memberId) ||
    { id: thread?.memberId, name: "已移除的成员", avatar: "robot", removed: true };

  // ---- streaming progress ---------------------------------------------------------------------
  api.onProgress(({ requestId, text }) => {
    const entry = running.get(requestId);
    if (!entry?.pending) return;
    entry.pending.text = text;
    if (entry.frame) return;
    entry.frame = requestAnimationFrame(() => {
      entry.frame = 0;
      paintPending(entry);
    });
  });
  api.onActivity(({ requestId, text, thinking }) => {
    const entry = running.get(requestId);
    if (!entry?.pending) return;
    entry.pending.activity = text;
    if (thinking) updateThinking(entry.pending.thinking ??= [], thinking);
    paintPending(entry, true);
  });
  api.onTool(({ requestId, tool }) => {
    const entry = running.get(requestId);
    if (!entry?.pending) return;
    const previous = entry.pending.tools.find((item) => item.id === tool.id);
    if (previous) Object.assign(previous, tool);
    else entry.pending.tools.push(tool);
    paintPending(entry, true);
  });

  // ---- one entry per conversation: its window, question box and unread count --------------------
  function entryFor(thread) {
    let entry = entries.get(thread.id);
    if (entry) return entry;
    entry = { threadId: thread.id, notebookId: ctx.notebook().id, draft: "", stick: true, open: false,
      seen: stored(`thread-seen:${thread.id}`, thread.turns.length), layout: stored(`thread-layout:${thread.id}`, { mode: "auto" }) };
    const member = () => memberOf(threadById(thread.id) || thread);
    entry.composer = createComposer({
      placeholder: `和 ${member().name} 私聊…（Ctrl+Enter 发送）`,
      members: () => [member()], defaultMember: member, describe: ctx.describe, notify: ctx.notify,
      attachments: ctx.attachments, compact: true,
      draft: { get: () => entry.draft, set: (value) => { entry.draft = value; } },
      submit: ({ question, files }) => send(entry, question, files)
    });
    entries.set(thread.id, entry);
    return entry;
  }

  const unread = (entry, thread) => entry.open ? 0 : Math.max(0, thread.turns.length - entry.seen);
  function markSeen(entry, thread) {
    if (entry.seen === thread.turns.length) return;
    entry.seen = thread.turns.length;
    store(`thread-seen:${thread.id}`, entry.seen);
  }

  // A question sent in a private window.
  async function send(entry, question, files = []) {
    if (entry.pending) throw new Error("这个窗口还在回答。");
    const thread = threadById(entry.threadId);
    if (!thread) throw new Error("这个窗口已关闭。");
    const requestId = crypto.randomUUID();
    track(entry, { id: requestId, question, member: memberOf(thread), text: "", tools: [], activity: "" },
      api.sendThread({ requestId, notebookId: entry.notebookId, threadId: entry.threadId, question,
        attachmentIds: files.map((ref) => ref.id) }));
  }

  // Show an answer being generated for this conversation, and store it when it arrives.
  function track(entry, pending, request) {
    entry.pending = pending;
    entry.stick = true;
    running.set(pending.id, entry);
    render();
    request.then((next) => ctx.accept(next?.state ?? next))
      .catch((error) => ctx.notify(`${pending.member.name}：${error.message}`))
      .finally(() => {
        cancelAnimationFrame(entry.frame);
        entry.frame = 0;
        running.delete(pending.id);
        entry.pending = undefined;
        render();
        ctx.rendered();
      });
  }

  // ---- window geometry --------------------------------------------------------------------------
  function area() {
    const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ribbon-height")) || 100) + 8;
    return { left: 8, top, right: innerWidth - 66, bottom: innerHeight - 10 };
  }

  function snapRect(kind) {
    const { left, top, right, bottom } = area();
    const width = right - left;
    const height = bottom - top;
    const half = { w: width / 2 - 4, h: height / 2 - 4 };
    return {
      "left-half": { x: left, y: top, w: half.w, h: height },
      "right-half": { x: left + width / 2 + 4, y: top, w: half.w, h: height },
      "top-right": { x: left + width / 2 + 4, y: top, w: half.w, h: half.h },
      "bottom-right": { x: left + width / 2 + 4, y: top + height / 2 + 4, w: half.w, h: half.h },
      "top-left": { x: left, y: top, w: half.w, h: half.h },
      "bottom-left": { x: left, y: top + height / 2 + 4, w: half.w, h: half.h },
      maximize: { x: left, y: top, w: width, h: height }
    }[kind];
  }

  // Windows left to arrange themselves: one takes the bottom-right quarter, two share the right
  // side, more form a grid that grows to the left.
  function autoRects(count) {
    const { left, top, right, bottom } = area();
    const height = bottom - top;
    const columns = count <= 2 ? 1 : count <= 4 ? 2 : 3;
    const rows = count === 1 ? 1 : Math.ceil(count / columns);
    const columnWidth = Math.max(360, Math.min((right - left) / columns, (right - left) * (count <= 2 ? .45 : .34)));
    const rowHeight = count === 1 ? Math.max(380, height / 2) : height / rows;
    return Array.from({ length: count }, (_, index) => {
      const column = Math.floor(index / rows);
      const row = index % rows;
      return { x: right - (columns - column) * columnWidth, y: count === 1 ? bottom - rowHeight : top + row * rowHeight,
        w: columnWidth - 8, h: rowHeight - 8 };
    });
  }

  function clampRect(rect) {
    const { left, top, right, bottom } = area();
    const w = Math.max(320, Math.min(rect.w, innerWidth - 16));
    const h = Math.max(260, Math.min(rect.h, bottom - top));
    return { w, h, x: Math.max(left - w + 120, Math.min(rect.x, right - 120)), y: Math.max(top, Math.min(rect.y, bottom - 60)) };
  }

  function place() {
    const open = [...entries.values()].filter((entry) => entry.open && entry.win?.isConnected);
    const auto = open.filter((entry) => entry.layout.mode === "auto");
    const rects = autoRects(auto.length);
    for (const entry of open) {
      const rect = entry.layout.mode === "auto" ? rects[auto.indexOf(entry)]
        : entry.layout.mode === "snap" ? snapRect(entry.layout.snap) : clampRect(entry.layout.rect);
      Object.assign(entry.win.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
      entry.win.dataset.layout = entry.layout.mode;
    }
  }

  function setLayout(entry, layout) {
    entry.layout = layout;
    store(`thread-layout:${entry.threadId}`, layout);
    place();
  }

  function raise(entry) {
    entry.win.style.zIndex = String(++stack);
  }

  // Drag the title bar to move; dropping at a screen edge snaps like a desktop window.
  function draggable(entry, handle) {
    let drag;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, summary, details")) return;
      const box = entry.win.getBoundingClientRect();
      drag = { id: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top, w: box.width, h: box.height };
      handle.setPointerCapture(event.pointerId);
      raise(entry);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (drag?.id !== event.pointerId) return;
      entry.layout = { mode: "manual", rect: clampRect({ x: event.clientX - drag.dx, y: event.clientY - drag.dy, w: drag.w, h: drag.h }) };
      place();
      const edge = event.clientX < 14 ? "left-half" : event.clientX > innerWidth - 14 ? "right-half"
        : event.clientY < area().top + 4 ? "maximize" : "";
      layer.dataset.snapHint = edge;
    });
    const stop = (event) => {
      if (drag?.id !== event.pointerId) return;
      drag = undefined;
      const edge = layer.dataset.snapHint;
      layer.dataset.snapHint = "";
      setLayout(entry, edge ? { mode: "snap", snap: edge } : entry.layout);
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("lostpointercapture", stop);
    handle.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, summary, details")) return;
      setLayout(entry, entry.layout.mode === "snap" && entry.layout.snap === "maximize" ? { mode: "auto" } : { mode: "snap", snap: "maximize" });
    });
  }

  function resizable(entry, grip, sides) {
    let drag;
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const box = entry.win.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, box };
      grip.setPointerCapture(event.pointerId);
      raise(entry);
      event.preventDefault();
    });
    grip.addEventListener("pointermove", (event) => {
      if (drag?.id !== event.pointerId) return;
      const { box } = drag;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      const rect = { x: box.left, y: box.top, w: box.width, h: box.height };
      if (sides.includes("w")) { rect.x += dx; rect.w -= dx; }
      if (sides.includes("e")) rect.w += dx;
      if (sides.includes("n")) { rect.y += dy; rect.h -= dy; }
      if (sides.includes("s")) rect.h += dy;
      if (rect.w < 320) { if (sides.includes("w")) rect.x -= 320 - rect.w; rect.w = 320; }
      if (rect.h < 260) { if (sides.includes("n")) rect.y -= 260 - rect.h; rect.h = 260; }
      entry.layout = { mode: "manual", rect };
      place();
    });
    const stop = (event) => {
      if (drag?.id !== event.pointerId) return;
      drag = undefined;
      setLayout(entry, entry.layout);
    };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("lostpointercapture", stop);
  }

  // ---- a window -----------------------------------------------------------------------------------
  function transcript(thread) {
    const member = memberOf(thread);
    return [`**与 ${member.name} 的私聊**（${thread.turns.length} 轮）`,
      ...thread.turns.flatMap((turn) => [`**我**：${turn.question}`, `**${member.name}**：${turn.answer}`])].join("\n\n");
  }

  function publish(thread) {
    if (!thread.turns.length) return ctx.notify("这个窗口还没有对话。");
    const member = memberOf(thread);
    ctx.edit({
      heading: thread.visibility === "public" ? `更新发布：与 ${member.name} 的私聊` : `把与 ${member.name} 的私聊发布到群聊`,
      reference: "先删改整理，只留下要让群里知道的内容。发布后作为笔记块放在群聊末尾，进入之后所有成员的上下文。",
      text: transcript(thread), limit: 160_000, rows: 16, wide: true,
      save: async (text) => {
        await ctx.change({ type: "publish-thread", id: thread.id, text,
          source: { memberId: member.id, memberName: member.name, avatar: member.avatar, provider: ctx.provider(member) } });
        ctx.rendered();
        render();
        ctx.notify(`已发布到群聊。之后的提问会带上和 ${member.name} 的私聊。`);
      }
    });
  }

  function turnActions(thread, turn) {
    const edit = button("编辑", "comment-turn-action", "修改这条回答的记录");
    edit.addEventListener("click", () => ctx.edit({
      heading: "编辑这条记录", reference: turn.question, text: turn.answer, limit: 160_000, rows: 12, wide: true,
      save: async (text) => {
        await ctx.change({ type: "edit-thread-turn", id: thread.id, turnId: turn.id, answer: text });
        render();
      }
    }));
    const remove = button("删除", "comment-turn-action", "删掉这一问一答");
    remove.addEventListener("click", async () => {
      if (!window.confirm("删除这一问一答？")) return;
      try {
        await ctx.change({ type: "delete-thread-turn", id: thread.id, turnId: turn.id });
        render();
      } catch (error) { ctx.notify(error.message); }
    });
    return [edit, remove];
  }

  function pendingView(entry) {
    const pending = entry.pending;
    const box = create("div", "comment-progress");
    const asked = create("div", "comment-ask");
    asked.append(create("p", "question-bubble", pending.question));
    const reply = create("div", "comment-reply is-pending");
    const meta = create("div", "comment-reply-meta");
    const stop = button("停止");
    stop.addEventListener("click", async () => {
      stop.disabled = true;
      try { await api.stop(pending.id); } catch (error) { ctx.notify(error.message); stop.disabled = false; }
    });
    meta.append(pixelAvatar(pending.member.avatar, "thinking", ""), create("strong", "comment-progress-label"), stop);
    reply.append(meta, create("div", "comment-progress-tools"), create("div", "comment-progress-output markdown-content"));
    box.append(asked, reply);
    return box;
  }

  // The folded card a moved answer left in the chat shows the start of the answer as it arrives.
  function paintStub(entry) {
    const preview = document.querySelector(`[data-stub-thread="${entry.threadId}"] .thread-stub-preview`);
    if (!preview || !entry.pending) return;
    renderMarkdown(preview, entry.pending.text.slice(0, 600) || "");
    if (!entry.pending.text) preview.append(create("span", "typing-dots", "● ● ●"));
  }

  function paintPending(entry, withTools = false) {
    paintStub(entry);
    const pending = entry.pending;
    if (!entry.open || !entry.win || !pending) return;
    const label = entry.win.querySelector(".comment-progress-label");
    if (label) label.textContent = `${pending.member.name} ${pending.activity || (pending.text ? "正在输出" : "正在思考")}`;
    const avatar = entry.win.querySelector(".comment-progress .pixel-avatar");
    if (avatar) avatar.dataset.state = pending.activity?.includes("搜索") ? "searching" : pending.text ? "typing" : "thinking";
    if (withTools) {
      const details = toolDetails(pending.tools, pending.thinking, { running: !pending.text, key: pending.id });
      entry.win.querySelector(".comment-progress-tools")?.replaceChildren(...(details ? [details] : []));
    }
    const output = entry.win.querySelector(".comment-progress-output");
    if (output) {
      renderMarkdown(output, pending.text);
      if (pending.text) collapseWorkProgress(entry.win);
      if (!pending.text) output.append(create("span", "typing-dots", "● ● ●"));
    }
    if (entry.stick) entry.body.scrollTop = entry.body.scrollHeight;
  }

  function shell(entry) {
    const win = create("section", "thread-window");
    win.dataset.threadId = entry.threadId;
    const head = create("header", "thread-window-head");
    const body = create("div", "thread-turns");
    body.addEventListener("scroll", () => {
      entry.stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
    }, { passive: true });
    // The same conversation as a full chat (edit, collapse, highlight, annotate …), switched with ⤢.
    const full = create("div", "thread-full-chat");
    win.append(head, body, full, entry.composer.element);
    for (const sides of ["w", "e", "s", "n", "sw", "se", "nw", "ne"]) {
      const grip = create("span", `thread-grip is-${sides}`);
      resizable(entry, grip, sides);
      win.append(grip);
    }
    win.addEventListener("pointerdown", () => raise(entry), { capture: true });
    draggable(entry, head);
    Object.assign(entry, { win, head, body, full });
    raise(entry);
  }

  function showFull(entry, thread) {
    entry.fullView = true;
    entry.win.classList.add("is-full-chat");
    api.childChatId({ kind: "thread", notebookId: entry.notebookId, itemId: thread.id })
      .then((id) => { if (entry.fullView) embedChat(entry.full, id, { label: "私聊" }); })
      .catch((error) => ctx.notify(error.message));
  }

  function paintWindow(entry, thread) {
    if (!entry.win) shell(entry);
    const member = memberOf(thread);
    const who = create("div", "thread-who");
    const names = create("div");
    names.append(create("strong", "", member.name),
      create("span", "", member.removed ? "这位成员已被移除" : `私聊 · ${ctx.describe(member)}`));
    who.append(pixelAvatar(member.avatar, entry.pending ? "thinking" : "idle", ""), names);
    const badge = create("span", "thread-badge", thread.visibility === "public" ? "已发布" : "私有");
    badge.title = thread.visibility === "public" ? "群聊里有这段私聊的整理稿，所有成员都能看到" : "只有你和这位成员知道这段对话";
    const tools = create("div", "thread-tools");
    const share = button(thread.visibility === "public" ? "更新发布" : "发布到群聊", thread.visibility === "public" ? "" : "primary");
    share.title = "编辑整理后放进群聊，进入之后的上下文";
    share.disabled = !thread.turns.length || Boolean(entry.pending);
    share.addEventListener("click", () => publish(threadById(thread.id) || thread));
    tools.append(share);
    if (thread.visibility === "public") {
      const hide = button("设为私有", "", "从群聊里撤回这段私聊的整理稿");
      hide.addEventListener("click", async () => {
        if (!window.confirm("从群聊撤回这段私聊？群聊里对应的笔记块会被移除。")) return;
        try {
          await ctx.change({ type: "unpublish-thread", id: thread.id });
          ctx.rendered();
          render();
        } catch (error) { ctx.notify(error.message); }
      });
      tools.append(hide);
    }
    const layout = create("details", "thread-layout-menu");
    const trigger = create("summary", "", "⊞");
    trigger.title = "窗口布局";
    const options = create("div", "thread-layout-options");
    const auto = button("自动排列");
    auto.addEventListener("click", () => { layout.open = false; setLayout(entry, { mode: "auto" }); });
    options.append(auto, ...Object.entries(snaps).map(([kind, label]) => {
      const option = button(label);
      option.addEventListener("click", () => { layout.open = false; setLayout(entry, { mode: "snap", snap: kind }); });
      return option;
    }));
    layout.append(trigger, options);
    const minimize = button("–", "thread-minimize", "收起到右侧头像");
    minimize.addEventListener("click", () => { entry.open = false; render(); });
    const close = button("×", "thread-close", "关闭并删除这个私聊（已发布的内容会留在群聊里）");
    close.addEventListener("click", async () => {
      if (entry.pending) return ctx.notify("请先停止这个窗口正在生成的回答。");
      if (thread.turns.length && !window.confirm(`删除和 ${member.name} 的私聊？对话记录会删除，已发布到群聊的内容会保留。`)) return;
      try {
        await ctx.change({ type: "delete-thread", id: thread.id });
        void entry.composer.discard();
        entry.win?.remove();
        entries.delete(thread.id);
        render();
      } catch (error) { ctx.notify(error.message); }
    });
    const full = button("↗", "thread-full", "在新窗口以完整会话打开");
    full.addEventListener("click", () => api.openChildChat({ kind: "thread", notebookId: entry.notebookId, itemId: thread.id })
      .catch((error) => ctx.notify(error.message)));
    tools.append(full, layout, minimize, close);
    entry.head.replaceChildren(who, badge, tools);

    showFull(entry, thread);
  }


  function paintDock() {
    const list = threads();
    const heads = list.map((thread) => {
      const entry = entryFor(thread);
      const member = memberOf(thread);
      const count = unread(entry, thread);
      const head = button("", `thread-head${entry.open ? " is-open" : ""}${entry.pending ? " is-running" : ""}${count ? " has-unread" : ""}`);
      head.title = `${member.name} · ${entry.pending ? "正在回答" : `${thread.turns.length} 轮`}${count ? ` · ${count} 条新回答` : ""}` +
        `${thread.visibility === "public" ? " · 已发布" : " · 私有"}（点击${entry.open ? "收起" : "打开"}）`;
      head.setAttribute("aria-label", head.title);
      head.append(pixelAvatar(member.avatar, entry.pending ? "thinking" : "idle", ""));
      if (entry.pending) head.append(create("span", "thread-head-ring"));
      if (count) head.append(create("span", "thread-head-count", String(count)));
      else if (!entry.pending && thread.turns.length && !entry.open && entry.finished) head.append(create("span", "thread-head-dot"));
      head.addEventListener("click", () => toggle(thread.id));
      return head;
    });
    const add = button("＋", "thread-add", "开一个私聊小窗");
    add.setAttribute("aria-expanded", String(menuOpen));
    add.addEventListener("click", () => { menuOpen = !menuOpen; paintDock(); });
    const parts = [...heads, add];
    if (menuOpen) {
      const menu = create("div", "thread-menu");
      menu.append(create("p", "thread-menu-title", "和谁私聊"), ...ctx.members().map((member) => {
        const item = button("", "thread-menu-item");
        item.append(pixelAvatar(member.avatar, "idle", ""), create("span", "", member.name));
        item.addEventListener("click", () => { menuOpen = false; void start(member); });
        return item;
      }));
      if (list.length) {
        const tidy = button("全部自动排列", "thread-menu-item");
        tidy.addEventListener("click", () => {
          menuOpen = false;
          for (const entry of entries.values()) if (entry.open) setLayout(entry, { mode: "auto" });
          paintDock();
        });
        const hide = button("全部收起", "thread-menu-item");
        hide.addEventListener("click", () => {
          menuOpen = false;
          for (const entry of entries.values()) entry.open = false;
          render();
        });
        const summary = button("让默认成员汇总已发布的私聊", "thread-menu-item");
        summary.addEventListener("click", () => { menuOpen = false; paintDock(); ctx.summarize(); });
        menu.append(tidy, hide, summary);
      }
      parts.push(menu);
    }
    dock.replaceChildren(...parts);
  }

  function render() {
    if (!ctx.notebook()) return;
    keepFocus(() => {
      const list = threads();
      const ids = new Set(list.map((thread) => thread.id));
      for (const [id, entry] of entries) {
        if (!ids.has(id) && !entry.pending) {
          entry.win?.remove();
          entries.delete(id);
        }
      }
      for (const thread of list) {
        const entry = entryFor(thread);
        if (entry.open) {
          paintWindow(entry, thread);
          markSeen(entry, thread);
          if (entry.win.parentElement !== layer) layer.append(entry.win);
        } else entry.win?.remove();
      }
      place();
      paintDock();
    });
  }

  function toggle(threadId, open) {
    const entry = entries.get(threadId);
    if (!entry) return;
    entry.open = open ?? !entry.open;
    entry.finished = false;
    render();
    if (entry.open) {
      raise(entry);
      entry.full.querySelector("iframe")?.focus();
    }
  }

  async function start(member, origin) {
    try {
      await ctx.change({ type: "add-thread", memberId: member.id, ...(origin ? { origin } : {}) });
      const thread = threads().at(-1);
      entryFor(thread);
      toggle(thread.id, true);
    } catch (error) { ctx.notify(error.message); }
  }

  addEventListener("resize", place);
  return {
    render,
    start,
    open: (threadId) => toggle(threadId, true),
    toggleMenu: () => { menuOpen = !menuOpen; paintDock(); },
    // A main-chat answer moved here while generating: it keeps running and its window stays closed;
    // the avatar spins, then shows a green count when the answer is in.
    adopt: (threadId, pending, request) => {
      const thread = threadById(threadId);
      if (!thread) return;
      const entry = entryFor(thread);
      entry.finished = true;
      track(entry, pending, request);
    },
    // Each notebook has its own conversations; switching notebooks closes the other windows.
    reset: () => {
      for (const [id, entry] of entries) {
        if (entry.notebookId !== ctx.notebook()?.id) {
          entry.win?.remove();
          if (!entry.pending) {
            void entry.composer.discard();
            entries.delete(id);
          }
        }
      }
      render();
    },
    busy: () => running.size > 0,
    // For the chat's folded cards: whether this conversation is answering, and what it has so far.
    progress: (threadId) => {
      const pending = entries.get(threadId)?.pending;
      return pending ? { text: pending.text, activity: pending.activity } : null;
    },
    unread: (threadId) => {
      const entry = entries.get(threadId);
      const thread = threadById(threadId);
      return entry && thread ? unread(entry, thread) : 0;
    }
  };
}
