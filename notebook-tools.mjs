import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { NotebookStore, requireText } from "./store.mjs";
import { messageGroups } from "./notebook.mjs";
import { validateComments } from "./pdf-review.mjs";
import { childKey } from "./child-chats.mjs";
import { shiftAnnotations } from "./md-document.mjs";
import { repeatLabel } from "./todos.mjs";

// A time for a to-do: an absolute date ("2026-12-01T09:00", local time unless it says otherwise) or
// one relative to now ({ amount, unit: minute | hour | day | week | month }).
export function todoTime({ dueAt, after } = {}, now = Date.now()) {
  if (after && typeof after === "object") {
    const amount = Number(after.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("after.amount 需要是正数。");
    const date = new Date(now);
    if (after.unit === "minute") date.setMinutes(date.getMinutes() + amount);
    else if (after.unit === "hour") date.setHours(date.getHours() + amount);
    else if (after.unit === "day") date.setDate(date.getDate() + amount);
    else if (after.unit === "week") date.setDate(date.getDate() + 7 * amount);
    else if (after.unit === "month") date.setMonth(date.getMonth() + amount);
    else throw new Error("after.unit 只能是 minute、hour、day、week 或 month。");
    return date.getTime();
  }
  if (dueAt === null) return null;
  if (dueAt === undefined || dueAt === "") return undefined;
  const time = Date.parse(String(dueAt).trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"));
  if (!Number.isFinite(time)) throw new Error("dueAt 需要是日期时间，例如 2026-12-01T09:00。");
  return time;
}
const todoView = (todo) => ({ id: todo.id, text: todo.text, status: todo.status,
  dueAt: todo.dueAt ? new Date(todo.dueAt).toISOString() : null,
  dueLocal: todo.dueAt ? new Date(todo.dueAt).toLocaleString("zh-CN", { hour12: false }) : null,
  repeat: todo.repeat ? repeatLabel(todo.repeat) : null, ai: todo.ai, memberId: todo.memberId,
  notebookId: todo.chatId, chatTitle: todo.chatTitle, messageId: todo.blockId, quote: todo.quote, runs: todo.runs,
  lastRunAt: todo.lastRunAt ? new Date(todo.lastRunAt).toISOString() : null, lastError: todo.lastError });

const limitNumber = (value, fallback, max) => Math.max(0, Math.min(max, Number.isInteger(value) ? value : fallback));
const excerpt = (value, max = 320) => String(value || "").replace(/\s+/g, " ").slice(0, max);

export class NotebookTools {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.store = new NotebookStore(join(dataDir, "notebook.sqlite"));
  }

  close() { this.store.close(); }

  list({ query = "", limit = 30 } = {}) {
    const q = String(query).toLocaleLowerCase();
    const summary = (type, id, title, body) => {
      const at = q ? body.toLocaleLowerCase().indexOf(q) : 0;
      if (q && !title.toLocaleLowerCase().includes(q) && at < 0) return null;
      return { type, id, title, preview: excerpt(body.slice(Math.max(0, at - 100), Math.max(0, at - 100) + 350)) };
    };
    const chats = this.store.readAll().map((chat) => summary("chat", chat.id, chat.title,
      [...chat.blocks.filter((block) => !block.removed).map((block) => block.text),
        ...(chat.notes || []).map((note) => note.text)].join("\n")));
    const docs = this.store.mdDocuments().map((entry) => {
      const doc = this.store.mdDocument(entry.id);
      return summary("md", doc.id, doc.name, [doc.text, ...doc.comments.map((item) => item.text)].join("\n"));
    });
    const pdfs = this.store.pdfReviews().map((entry) => {
      const review = this.store.pdfReview(entry.hash);
      return summary("pdf", entry.hash, entry.name, review.comments.map((item) =>
        `${item.quote} ${item.title} ${item.text}`).join("\n"));
    });
    return [...chats, ...docs, ...pdfs].filter(Boolean).slice(0, limitNumber(limit, 30, 100));
  }

  readChat({ notebookId, cursor = 0, limit = 20 } = {}) {
    const chat = this.store.read(notebookId);
    const groups = messageGroups(chat.blocks);
    const start = limitNumber(cursor, 0, groups.length);
    const end = Math.min(groups.length, start + Math.max(1, limitNumber(limit, 20, 40)));
    return { id: chat.id, title: chat.title, parent: chat.parent || null,
      totalMessages: groups.length, nextCursor: end < groups.length ? end : null,
      messages: groups.slice(start, end).map((group) => ({ id: group.blocks[0].id, kind: group.kind,
        text: group.blocks.filter((block) => !block.removed).map((block) => block.text).join("\n\n").slice(0, 4000),
        truncated: group.blocks.some((block) => block.text.length > 4000),
        ...(group.blocks[0].noteType ? { noteType: group.blocks[0].noteType } : {}),
        ...(group.blocks[0].mdId ? { mdId: group.blocks[0].mdId } : {}),
        attachments: group.blocks.flatMap((block) => block.attachments || []).map(({ id, name, extension }) => ({ id, name, extension })),
        toolCount: group.blocks.reduce((count, block) => count + (block.tools?.length || 0), 0) })),
      annotationCount: (chat.notes || []).length,
      annotations: (chat.notes || []).filter((note) => groups.slice(start, end).some((group) =>
        group.blocks.some((block) => block.id === note.anchor.blockId))).slice(0, 30)
        .map(({ id, anchor, text }) => ({ id, blockId: anchor.blockId,
          quote: excerpt(anchor.quote, 200), text: excerpt(text, 400) })) };
  }

  readMessage({ notebookId, messageId, offset = 0, limit = 12000 } = {}) {
    const chat = this.store.read(notebookId);
    const group = messageGroups(chat.blocks).find((item) => item.blocks[0].id === messageId);
    if (!group) throw new Error("消息不存在。");
    const body = group.blocks.filter((block) => !block.removed).map((block) => block.text).join("\n\n");
    const tools = group.blocks.flatMap((block) => block.tools || []);
    const text = [body, ...tools.map((tool) => `\n[${tool.title || "工具"}] ${tool.detail || ""}\n${tool.result || ""}`)].join("\n");
    const start = limitNumber(offset, 0, text.length);
    const size = Math.max(1, limitNumber(limit, 12000, 30000));
    return { notebookId, messageId, text: text.slice(start, start + size), totalChars: text.length,
      nextOffset: start + size < text.length ? start + size : null };
  }

  readMarkdown({ mdId, offset = 0, limit = 12000 } = {}) {
    const doc = this.store.mdDocument(mdId);
    if (!doc) throw new Error("Markdown 文档不存在。");
    const start = limitNumber(offset, 0, doc.text.length);
    const size = Math.max(1, limitNumber(limit, 12000, 30000));
    return { id: doc.id, name: doc.name, path: doc.path, version: doc.version, unsynced: doc.unsynced,
      fileConflict: Boolean(doc.fileConflict), text: doc.text.slice(start, start + size),
      totalChars: doc.text.length, nextOffset: start + size < doc.text.length ? start + size : null,
      annotationCount: doc.comments.length,
      annotations: doc.comments.filter((item) => item.start >= start && item.start < start + size).slice(0, 30)
        .map(({ id, start, quote, text }) => ({ id, start, quote: excerpt(quote, 200), text: excerpt(text, 400) })) };
  }

  readPdfReview({ hash, cursor = 0, limit = 30 } = {}) {
    const review = this.store.pdfReview(hash);
    if (!review) throw new Error("PDF 审阅不存在。");
    const start = limitNumber(cursor, 0, review.comments.length);
    const end = Math.min(review.comments.length, start + Math.max(1, limitNumber(limit, 30, 40)));
    return { hash, name: review.name, path: join(this.dataDir, "reviews", `${hash}.pdf`),
      annotationCount: review.comments.length, nextCursor: end < review.comments.length ? end : null,
      annotations: review.comments.slice(start, end).map(({ id, page, quote, title, text }) =>
        ({ id, page, quote: excerpt(quote, 300), title, text: excerpt(text, 1000) })) };
  }

  readAnnotation({ kind = "chat", notebookId, mdId, hash, annotationId } = {}) {
    let item;
    let chat;
    if (kind === "chat") {
      const owner = this.store.read(notebookId);
      item = owner.notes.find((note) => note.id === annotationId);
      chat = this.store.childChat(childKey.note(notebookId, annotationId));
    } else if (kind === "md") {
      item = this.store.mdDocument(mdId)?.comments.find((note) => note.id === annotationId);
      chat = this.store.childChat(childKey.mdComment(mdId, annotationId));
    } else if (kind === "pdf") {
      item = this.store.pdfReview(hash)?.comments.find((note) => note.id === annotationId);
      chat = this.store.childChat(childKey.pdfComment(hash, annotationId));
    }
    if (!item) throw new Error("批注不存在。");
    const { turns, ...annotation } = item;
    return { ...annotation, chatId: chat?.id || null, chatMessages: chat?.blocks.length || turns?.length || 0 };
  }

  saveMarkdown({ mdId, name, text, notebookId, afterId, expectedVersion } = {}) {
    const old = mdId ? this.store.mdDocument(mdId) : null;
    if (mdId && !old) throw new Error("Markdown 文档不存在。");
    if (old && expectedVersion !== old.version) {
      if (typeof text === "string") this.store.mdVersion(old.id, text, "Agent 未合并的修改草稿");
      throw new Error("文档可能已在应用中修改。请先 read_markdown，再把返回的 version 作为 expectedVersion 传入更新，不能直接覆盖现有草稿。");
    }
    if (old) this.store.mdVersion(old.id, old.text, "Agent 修改前的应用版本", old.fileHash);
    const next = this.store.saveMdDocument(old?.id || randomUUID(), {
      ...old, name: requireText(name || old?.name, 250).trim(), text: typeof text === "string" ? text : old?.text,
      comments: old ? shiftAnnotations(old.text, typeof text === "string" ? text : old.text, old.comments) : [],
      marks: old ? shiftAnnotations(old.text, typeof text === "string" ? text : old.text, old.marks || []) : [],
      chat: old?.chat || [], unsynced: true, ...(old ? { expectedVersion } : {})
    });
    const state = notebookId ? this.store.addMarkdownBlock(notebookId, next.id, afterId) : null;
    return { id: next.id, name: next.name, version: next.version, notebookId: state?.id || null,
      link: `[${next.name}](ownsoft://md/${next.id})` };
  }

  importMarkdown({ path, notebookId, afterId } = {}) {
    if (typeof path !== "string" || !isAbsolute(path) || !/\.(?:md|markdown|mdown|mkd|txt)$/i.test(path)) {
      throw new Error("请提供绝对路径的 Markdown 文档。");
    }
    if (statSync(path).size > 5_000_000) throw new Error("Markdown 文档不能超过 5 MB。");
    const bytes = readFileSync(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    const old = this.store.mdDocumentByPath(path);
    if (old?.unsynced && old.text !== text) throw new Error("应用内文档已有未写回的修改，请先处理冲突。");
    const doc = this.store.saveMdDocument(old?.id || randomUUID(), {
      ...old, name: basename(path), path, text, comments: old?.comments || [], chat: old?.chat || [],
      fileHash: createHash("sha256").update(bytes).digest("hex"), fileText: text, unsynced: false,
      marks: old ? shiftAnnotations(old.text, text, old.marks || []) : [], ...(old ? { expectedVersion: old.version } : {})
    });
    const state = notebookId ? this.store.addMarkdownBlock(notebookId, doc.id, afterId) : null;
    return { id: doc.id, name: doc.name, notebookId: state?.id || null,
      link: `[${doc.name}](ownsoft://md/${doc.id})` };
  }

  addNoteBlock({ notebookId, text, afterId } = {}) {
    const before = new Set(this.store.read(notebookId).blocks.map((block) => block.id));
    const state = this.store.change({ type: "add-shared-block", text, afterId }, notebookId);
    return { notebookId: state.id, blockId: state.blocks.find((block) => !before.has(block.id))?.id,
      revision: state.revision };
  }

  insertMarkdownBlock({ notebookId, mdId, afterId } = {}) {
    const before = new Set(this.store.read(notebookId).blocks.map((block) => block.id));
    const state = this.store.addMarkdownBlock(notebookId, mdId, afterId);
    return { notebookId: state.id, mdId, blockId: state.blocks.find((block) => !before.has(block.id))?.id,
      revision: state.revision };
  }

  resolveMessage({ messageId } = {}) {
    const found = this.store.resolveAnnotationMessage(messageId);
    return { notebookId: found.notebookId, messageId: found.messageId, title: found.title,
      blocks: found.blocks.map(({ id, text }) => ({ id, preview: excerpt(text, 300) })) };
  }

  moveMessageToAnnotation({ sourceId, messageIds, targetId, anchor } = {}) {
    return this.store.moveMessageToChatAnnotation(sourceId, messageIds, targetId, anchor);
  }

  undoMessageAnnotation({ targetId, noteId } = {}) {
    this.store.undoChatAnnotation(targetId, noteId);
    return { targetId, noteId, restored: true };
  }

  annotate({ kind = "chat", notebookId, mdId, hash, blockId, page, quote, text, title = "" } = {}) {
    requireText(text, 20_000);
    if (kind === "chat") {
      const chat = this.store.read(notebookId);
      const block = chat.blocks.find((item) => item.id === blockId && !item.removed);
      if (!block) throw new Error("消息不存在。");
      const phrase = requireText(quote, 8000);
      const start = block.text.indexOf(phrase);
      if (start < 0 || block.text.indexOf(phrase, start + 1) >= 0) throw new Error("引句不存在或出现多次，请提供更完整的引句。");
      const state = this.store.change({ type: "add-note", anchor: { blockId, start, quote: phrase }, text }, notebookId);
      return { id: state.notes.at(-1).id, notebookId: state.id };
    }
    if (kind === "md") {
      const doc = this.store.mdDocument(mdId);
      if (!doc) throw new Error("Markdown 文档不存在。");
      const phrase = requireText(quote, 8000);
      const start = doc.text.indexOf(phrase);
      if (start < 0 || doc.text.indexOf(phrase, start + 1) >= 0) throw new Error("引句不存在或出现多次，请提供更完整的引句。");
      const comment = { id: randomUUID(), start, quote: phrase, title: String(title).slice(0, 160), text };
      this.store.saveMdDocument(doc.id, { ...doc, comments: [...doc.comments, comment] });
      return { id: comment.id, mdId };
    }
    if (kind === "pdf") {
      const review = this.store.pdfReview(hash);
      if (!review) throw new Error("PDF 审阅不存在。");
      const comment = { id: randomUUID(), page, rects: [], title: String(title).slice(0, 160),
        text, quote: String(quote || "").slice(0, 8000), priority: "" };
      validateComments([comment]);
      this.store.savePdfReview(hash, review.name, { ...review, comments: [...review.comments, comment] });
      return { id: comment.id, hash, page, note: "文字批注已添加；没有页面下划线坐标。" };
    }
    throw new Error("批注类型无效。");
  }

  // ---- to-dos: the AI can plan its own next steps (see todos.mjs) --------------------------------
  listTodos({ status = "", limit = 50 } = {}) {
    return this.store.todos().filter((todo) => !status || todo.status === status)
      .slice(0, limitNumber(limit, 50, 200)).map(todoView);
  }

  // fromTodoId: take the source (chat, message, quoted words) of that to-do, e.g. the one being done now.
  addTodo({ text, dueAt, after, repeat, notebookId, messageId, quote, fromTodoId, memberId, ai = true } = {}) {
    const from = fromTodoId ? this.store.todo(fromTodoId) : null;
    const time = todoTime({ dueAt, after });
    const todo = this.store.saveTodo({ text, dueAt: time ?? null, repeat: repeat || null,
      chatId: from ? from.chatId : notebookId, blockId: from ? from.blockId : messageId, quote: from ? from.quote : quote || "",
      memberId: memberId ?? from?.memberId ?? null, ai });
    return todoView(todo);
  }

  // Reschedule (dueAt / after), reword, change the repeat, or mark done / open again.
  updateTodo({ todoId, text, dueAt, after, repeat, status, ai } = {}) {
    const time = todoTime({ dueAt, after });
    const fields = {};
    if (text !== undefined) fields.text = text;
    if (time !== undefined) fields.dueAt = time;
    if (repeat !== undefined) fields.repeat = repeat;
    if (status !== undefined) {
      if (!["open", "done"].includes(status)) throw new Error("status 只能是 open 或 done。");
      fields.status = status;
    }
    if (ai !== undefined) fields.ai = ai;
    // A new time puts it back on the list.
    if (time && status === undefined) fields.status = "open";
    return todoView(this.store.saveTodo(fields, todoId));
  }

  editAnnotation({ kind = "chat", notebookId, mdId, hash, annotationId, text } = {}) {
    requireText(text, 20_000);
    if (kind === "chat") {
      const state = this.store.change({ type: "edit-note", id: annotationId, text }, notebookId);
      return { id: annotationId, notebookId: state.id };
    }
    const doc = kind === "md" ? this.store.mdDocument(mdId) : kind === "pdf" ? this.store.pdfReview(hash) : null;
    if (!doc) throw new Error("文档不存在。");
    const comment = doc.comments.find((item) => item.id === annotationId);
    if (!comment) throw new Error("批注不存在。");
    comment.text = text;
    if (kind === "md") this.store.saveMdDocument(doc.id, doc);
    else this.store.savePdfReview(hash, doc.name, doc);
    return { id: annotationId, ...(kind === "md" ? { mdId } : { hash }) };
  }
}
