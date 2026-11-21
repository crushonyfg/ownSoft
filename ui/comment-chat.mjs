import { renderMarkdown } from "./markdown-dom.mjs";

const create = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const button = (text) => {
  const control = create("button", "", text);
  control.type = "button";
  return control;
};

const providerLabel = (provider) => ({ claude: "Claude", gemini: "Gemini" })[provider] || "GPT";
const speakerLabel = (source) => source?.memberName || providerLabel(source?.provider);

function toolDetails(items = []) {
  if (!items.length) return null;
  const details = create("details", "tool-details");
  details.append(create("summary", "", `工具调用 · ${items.length} 项`));
  const list = create("div", "tool-list");
  for (const item of items) {
    const row = create("div", "tool-item");
    row.append(create("span", `tool-status is-${item.status || "done"}`,
      item.status === "running" ? "◌" : item.status === "failed" ? "!" : "✓"),
    create("strong", "", item.title || "工具调用"));
    if (item.detail) row.append(create("span", "tool-detail", item.detail));
    list.append(row);
  }
  details.append(list);
  return details;
}

export function setupCommentChats(api, { profile, notify, openFork }) {
  const threads = new Map();
  const running = new Map();
  api.onProgress(({ requestId, text }) => {
    const thread = running.get(requestId);
    if (!thread) return;
    thread.pending.text = text;
    if (thread.pending.frame) return;
    thread.pending.frame = requestAnimationFrame(() => {
      if (running.get(requestId) !== thread) return;
      thread.pending.frame = 0;
      thread.paintProgress?.();
    });
  });
  api.onActivity(({ requestId, text }) => {
    const thread = running.get(requestId);
    if (!thread?.pending) return;
    thread.pending.activity = text;
    thread.paintActivity?.();
  });
  api.onTool(({ requestId, tool }) => {
    const thread = running.get(requestId);
    if (!thread?.pending) return;
    const previous = thread.pending.tools.find((item) => item.id === tool.id);
    if (previous) Object.assign(previous, tool);
    else thread.pending.tools.push(tool);
    thread.paintTools?.();
  });

  function mount(parent, { key, target, turns, receive, embedded = false }) {
    let thread = threads.get(key);
    if (!thread) {
      thread = { expanded: embedded, draft: "" };
      threads.set(key, thread);
    }
    const section = create("section", "comment-thread");
    const controls = create("div", "comment-thread-controls");
    const chat = button("追问");
    chat.dataset.commentChat = "";
    const fork = button("新开分支");
    fork.dataset.commentFork = "";
    controls.append(chat, fork);
    const conversation = create("div", "comment-conversation");
    const history = create("div", "comment-history");
    const progress = create("div", "comment-progress");
    const pendingQuestion = create("p", "question-bubble");
    const pendingAnswer = create("div", "markdown-content");
    const progressHeader = create("div", "comment-thread-controls");
    const progressTools = create("div");
    const progressLabel = create("span", "muted");
    const stop = button("停止");
    progressHeader.append(progressLabel, stop);
    progress.append(pendingQuestion, progressHeader, progressTools, pendingAnswer);
    const form = create("form", "comment-composer");
    const input = create("textarea");
    input.rows = 2;
    input.maxLength = 10_000;
    input.placeholder = embedded ? "针对这个 PDF 选区提问" : "针对这条批注提问";
    input.setAttribute("aria-label", input.placeholder);
    input.value = thread.draft;
    const send = button("发送");
    send.type = "submit";
    send.className = "primary";
    form.append(input, send);
    conversation.append(history, progress, form);
    if (!embedded) section.append(controls);
    section.append(conversation);
    parent.append(section);

    function paintProgress() {
      if (section.isConnected && !conversation.hidden && thread.pending) {
        renderMarkdown(pendingAnswer, thread.pending.text);
      }
    }

    function paint() {
      const previous = turns();
      chat.textContent = thread.expanded ? "收起追问" : previous.length ? `追问 · ${previous.length}` : "追问";
      chat.setAttribute("aria-expanded", String(thread.expanded));
      fork.disabled = Boolean(thread.pending || thread.forking);
      conversation.hidden = !thread.expanded;
      if (!thread.expanded) return;
      if (input.value !== thread.draft) input.value = thread.draft;
      history.replaceChildren(...previous.map((turn) => {
        const item = create("article", "comment-turn");
        const body = create("div", "markdown-content");
        renderMarkdown(body, turn.answer);
        item.append(create("p", "question-bubble", turn.question),
          create("p", "reply-source", speakerLabel(turn.source)));
        const tools = toolDetails(turn.tools);
        if (tools) item.append(tools);
        item.append(body);
        return item;
      }));
      const busy = Boolean(thread.pending);
      progress.hidden = !busy;
      input.disabled = send.disabled = busy;
      if (busy) {
        pendingQuestion.textContent = thread.pending.question;
        progressLabel.textContent = `${thread.pending.provider} ${thread.pending.activity || "正在回答"}`;
        const tools = toolDetails(thread.pending.tools);
        progressTools.replaceChildren(...(tools ? [tools] : []));
        stop.disabled = false;
        paintProgress();
      }
    }

    thread.paint = paint;
    thread.paintProgress = paintProgress;
    thread.paintTools = () => {
      if (section.isConnected && thread.pending) {
        const details = toolDetails(thread.pending.tools);
        progressTools.replaceChildren(...(details ? [details] : []));
      }
    };
    thread.paintActivity = () => {
      if (section.isConnected && thread.pending) {
        progressLabel.textContent = `${thread.pending.provider} ${thread.pending.activity || "正在回答"}`;
      }
    };
    chat.addEventListener("click", () => {
      thread.expanded = !thread.expanded;
      paint();
      if (thread.expanded && !input.disabled) input.focus();
    });
    fork.addEventListener("click", async () => {
      if (thread.forking) return;
      thread.forking = true;
      paint();
      try {
        await openFork(target());
      } catch (error) {
        notify(error.message);
      } finally {
        thread.forking = false;
        thread.paint?.();
      }
    });
    stop.addEventListener("click", async () => {
      if (!thread.pending) return;
      stop.disabled = true;
      try {
        await api.stop(thread.pending.id);
      } catch (error) {
        notify(error.message);
        stop.disabled = false;
      }
    });
    input.addEventListener("input", () => { thread.draft = input.value; });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (!question || thread.pending) return;
      const selected = profile();
      if (!selected) return;
      const requestId = crypto.randomUUID();
      thread.draft = input.value;
      thread.pending = { id: requestId, question, provider: selected.name || providerLabel(selected.provider), text: "", tools: [], frame: 0 };
      running.set(requestId, thread);
      paint();
      try {
        const result = await api.sendComment({ ...target(), question, requestId, memberId: selected.id });
        receive(result);
        thread.draft = "";
      } catch (error) {
        notify(error.message);
      } finally {
        cancelAnimationFrame(thread.pending.frame);
        running.delete(requestId);
        thread.pending = undefined;
        thread.paint?.();
      }
    });
    paint();
    return () => input.focus();
  }

  return {
    mount,
    pending: (prefix) => [...threads].some(([key, thread]) => key.startsWith(prefix) && thread.pending),
    forget: (prefix) => {
      for (const key of threads.keys()) {
        if (key.startsWith(prefix) && !threads.get(key).pending) threads.delete(key);
      }
    }
  };
}
