// Conversations attached to something: an annotation, a PDF annotation, a PDF selection or a
// whole PDF. They use the same question box as the group chat (members as @ chips, several
// members answer in turn, attachments), and keep their state while the page re-renders.
import { renderMarkdown } from "./markdown-dom.mjs";
import { createComposer, providerLabel } from "./chat-composer.mjs";
import { pixelAvatar } from "./pixel-avatars.mjs";
import { collapseWorkProgress, workProgress, updateThinking } from "./work-progress.mjs";

const create = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const button = (text, className = "") => {
  const control = create("button", className, text);
  control.type = "button";
  return control;
};

export const toolDetails = workProgress;

const isImage = (ref) => [".png", ".jpg", ".jpeg", ".webp"].includes(ref.extension);

export function turnAttachments(refs = [], open) {
  if (!refs.length) return null;
  const group = create("div", "attachments sent");
  group.append(...refs.map((ref) => {
    const link = button("", isImage(ref) ? "attachment-thumb" : "attachment-chip");
    link.title = ref.name;
    if (isImage(ref)) {
      const picture = create("img");
      picture.src = `notebook://app/note-image/${ref.id}`;
      picture.alt = ref.name;
      link.append(picture);
    } else link.append(create("span", "", ref.name));
    link.addEventListener("click", () => open?.(ref));
    return link;
  }));
  return group;
}

// One finished exchange as chat bubbles: the question on the right, the member's answer on the left.
export function chatTurn(turn, { speaker, openAttachment, actions = [] }) {
  const item = create("article", "comment-turn");
  const asked = create("div", "comment-ask");
  asked.append(create("p", "question-bubble", turn.question));
  const files = turnAttachments(turn.attachments, openAttachment);
  if (files) asked.append(files);
  const who = speaker(turn.source);
  const reply = create("div", "comment-reply");
  const meta = create("div", "comment-reply-meta");
  meta.append(pixelAvatar(who.avatar, "idle", ""), create("strong", "", who.name),
    create("span", "", [providerLabel(turn.source?.provider), turn.source?.model].filter(Boolean).join(" · ")));
  if (actions.length) {
    const tools = create("span", "comment-turn-actions");
    tools.append(...actions);
    meta.append(tools);
  }
  const body = create("div", "markdown-content");
  renderMarkdown(body, turn.answer);
  reply.append(meta);
  const tools = toolDetails(turn.tools, turn.source?.thinking);
  if (tools) reply.append(tools);
  reply.append(body);
  item.append(asked, reply);
  return item;
}

export function setupCommentChats(api, { members, defaultMember, describe, speaker, notify, openFork, attachments,
  notebookId = () => undefined,
  openAttachment }) {
  const threads = new Map();
  const running = new Map();
  api.onProgress(({ requestId, text }) => {
    const thread = running.get(requestId);
    if (!thread?.pending) return;
    thread.pending.text = text;
    if (thread.pending.frame) return;
    thread.pending.frame = requestAnimationFrame(() => {
      if (running.get(requestId) !== thread) return;
      thread.pending.frame = 0;
      thread.paintProgress?.();
    });
  });
  api.onActivity(({ requestId, text, thinking }) => {
    const thread = running.get(requestId);
    if (!thread?.pending) return;
    thread.pending.activity = text;
    if (thinking) updateThinking(thread.pending.thinking ??= [], thinking);
    thread.paintProgress?.(true);
  });
  api.onTool(({ requestId, tool }) => {
    const thread = running.get(requestId);
    if (!thread?.pending) return;
    const previous = thread.pending.tools.find((item) => item.id === tool.id);
    if (previous) Object.assign(previous, tool);
    else thread.pending.tools.push(tool);
    thread.paintProgress?.(true);
  });

  // The question box of one conversation, made once and moved into each new rendering.
  function composerFor(thread, options) {
    if (thread.composer) return thread.composer;
    thread.composer = createComposer({
      label: options.label, placeholder: options.placeholder, members, defaultMember, describe, notify,
      attachments: options.attachments === false ? null : attachments, compact: true,
      draft: { get: () => thread.draft, set: (value) => { thread.draft = value; } },
      submit: async ({ question, members: who, files }) => {
        // Several @-mentioned members answer in turn; each one sees the earlier answers.
        for (const [index, member] of who.entries()) {
          const requestId = crypto.randomUUID();
          thread.pending = { id: requestId, question, member, index, total: who.length, text: "", tools: [], frame: 0,
            waiting: who.slice(index + 1).map((item) => item.name) };
          running.set(requestId, thread);
          thread.paint?.();
          try {
            // The members shown are this chat's, so the answer comes from this chat's roster too.
            const result = await api.sendComment({ rosterNotebookId: notebookId(), ...thread.target(), question, requestId,
              memberId: member.id,
              attachmentIds: index ? [] : files.map((ref) => ref.id) });
            thread.receive(result);
          } catch (error) {
            if (index) throw new Error(`${member.name}：${error.message}（前面成员的回答已保存）`);
            throw error;
          } finally {
            cancelAnimationFrame(thread.pending?.frame);
            running.delete(requestId);
            thread.pending = undefined;
            thread.paint?.();
          }
        }
      }
    });
    return thread.composer;
  }

  /**
   * key: identifies the conversation; target(): what the main process needs to answer;
   * turns(): the finished exchanges; receive(result): store a new answer.
   * embedded: always open, without the 追问 / 新开分支 controls (PDF selections, whole PDFs).
   */
  // open(): shows this conversation as a full chat (its own window), where everything the main
  // chat can do is available.
  function mount(parent, { key, target, turns, receive, embedded = false, expanded, placeholder, label,
    forkable = true, attachments: allowFiles = true, turnActions, open }) {
    let thread = threads.get(key);
    if (!thread) {
      thread = { expanded: embedded || Boolean(expanded), draft: "" };
      threads.set(key, thread);
    }
    if (expanded) thread.expanded = true;
    Object.assign(thread, { target, receive });
    const composer = composerFor(thread, { label, attachments: allowFiles,
      placeholder: placeholder || (embedded ? "针对这里提问，@ 成员可让多位依次回答" : "追问这条批注，@ 成员可让多位依次回答") });
    const section = create("section", embedded ? "comment-thread is-embedded" : "comment-thread");
    const controls = create("div", "comment-thread-controls");
    const chat = button("追问");
    chat.dataset.commentChat = "";
    const fork = button("新开分支");
    fork.dataset.commentFork = "";
    fork.title = "把批注、原文和追问带到一个新会话里继续";
    controls.append(chat);
    if (forkable) controls.append(fork);
    const full = open && button("完整会话 ↗");
    if (full) {
      full.className = "comment-full";
      full.title = "在新窗口以完整会话打开：编辑、收起、高亮、转笔记或批注、多选、选上下文都能用";
      full.addEventListener("click", () => Promise.resolve().then(open).catch((error) => notify(error.message)));
      if (!embedded) controls.append(full);
    }
    const conversation = create("div", "comment-conversation");
    const history = create("div", "comment-history");
    const progress = create("div", "comment-progress");
    conversation.append(history, progress, composer.element);
    if (!embedded) section.append(controls);
    else if (full) {
      const bar = create("div", "comment-full-bar");
      bar.append(full);
      section.append(bar);
    }
    section.append(conversation);
    parent.append(section);

    function paintProgress(withTools = false) {
      if (!section.isConnected || conversation.hidden || !thread.pending) return;
      const pending = thread.pending;
      const label = progress.querySelector(".comment-progress-label");
      if (label) label.textContent = `${pending.member.name}${pending.total > 1 ? `（${pending.index + 1}/${pending.total}）` : ""} ${pending.activity || "正在回答"}`;
      const avatar = progress.querySelector(".pixel-avatar");
      if (avatar) avatar.dataset.state = pending.activity?.includes("搜索") ? "searching" : pending.text ? "typing" : "thinking";
      if (withTools || pending.thinking?.length) {
        const slot = progress.querySelector(".comment-progress-tools");
        const details = toolDetails(pending.tools, pending.thinking, { running: !pending.text, key: pending.id });
        slot?.replaceChildren(...(details ? [details] : []));
      }
      const output = progress.querySelector(".comment-progress-output");
      if (output) {
        renderMarkdown(output, pending.text);
        if (pending.text) collapseWorkProgress(progress);
        if (!pending.text) output.append(create("span", "typing-dots", "● ● ●"));
      }
    }

    // Cards are usually built before they are put on the page, so this draws detached sections too.
    function paint() {
      if (thread.paint !== paint) return;
      const previous = turns();
      chat.textContent = thread.expanded ? "收起追问" : previous.length ? `追问 · ${previous.length}` : "追问";
      chat.setAttribute("aria-expanded", String(thread.expanded));
      fork.disabled = Boolean(thread.pending || thread.forking);
      conversation.hidden = !thread.expanded;
      if (!thread.expanded) return;
      if (composer.element.parentElement !== conversation) conversation.append(composer.element);
      history.replaceChildren(...previous.map((turn) => chatTurn(turn, { speaker, openAttachment,
        actions: turnActions?.(turn) || [] })));
      const pending = thread.pending;
      progress.hidden = !pending;
      if (pending) {
        const header = create("div", "comment-reply-meta");
        const stop = button("停止");
        stop.addEventListener("click", async () => {
          stop.disabled = true;
          try { await api.stop(pending.id); } catch (error) { notify(error.message); stop.disabled = false; }
        });
        header.append(pixelAvatar(pending.member.avatar, "thinking", ""), create("strong", "comment-progress-label"), stop);
        const asked = create("div", "comment-ask");
        asked.append(create("p", "question-bubble", pending.question));
        const reply = create("div", "comment-reply is-pending");
        reply.append(header, create("div", "comment-progress-tools"), create("div", "comment-progress-output markdown-content"));
        if (pending.waiting.length) reply.append(create("p", "pending-queue", `接下来：${pending.waiting.join("、")}`));
        progress.replaceChildren(...(pending.index ? [] : [asked]), reply);
        paintProgress(true);
      }
      composer.refresh();
    }

    thread.paint = paint;
    thread.paintProgress = paintProgress;
    chat.addEventListener("click", () => {
      thread.expanded = !thread.expanded;
      paint();
      if (thread.expanded && !composer.busy) composer.focus();
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
    paint();
    return () => composer.focus();
  }

  return {
    mount,
    refresh: () => { for (const thread of threads.values()) thread.composer?.refresh(); },
    pending: (prefix) => [...threads].some(([key, thread]) => key.startsWith(prefix) && thread.pending),
    forget: (prefix) => {
      for (const [key, thread] of threads) {
        if (key.startsWith(prefix) && !thread.pending) {
          void thread.composer?.discard();
          threads.delete(key);
        }
      }
    }
  };
}
