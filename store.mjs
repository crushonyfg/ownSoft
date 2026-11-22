import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { applyMemberChange } from "./members.mjs";
import { DatabaseSync } from "node:sqlite";
import { findAnchor, initialNotebook, messageGroups, sameMessage, splitReply } from "./notebook.mjs";
import { validateComments, validateTurns } from "./pdf-review.mjs";
import { mdTextLimit, reanchor } from "./md-document.mjs";
import { appendTurn, chatTurns, childKey, childKinds, syncTurns } from "./child-chats.mjs";

// The conversation lists a chat shows from its child chats (see child-chats.mjs), as filled in on
// read: a write only syncs the lists that changed since.
const filledLists = new WeakMap();
const withoutTurns = (items) => items?.map(({ turns, ...rest }) => rest);
const label = (text, size = 40) => String(text || "").replace(/\s+/g, " ").trim().slice(0, size);
// A line of Markdown as plain text, for titles in lists and graphs.
const plain = (text, size) => label(String(text || "").replace(/[*_`#>~]+/g, ""), size);

const mdId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

// Annotations on a Markdown document: a passage of its source ({ start, quote }) and a note,
// with the follow-up conversation; "lost" when an edit removed the passage.
export function validateMdComments(comments, text) {
  if (!Array.isArray(comments) || comments.length > 1500) throw new Error("文档批注列表无效。");
  const ids = new Set();
  return comments.map((comment) => {
    const { id, start, quote, title = "", text: note, turns, lost } = comment || {};
    if (!/^[a-zA-Z\d_-]{1,80}$/.test(id || "") || ids.has(id) || !Number.isInteger(start) || start < 0 ||
        typeof quote !== "string" || !quote || quote.length > 8000 || typeof title !== "string" || title.length > 160 ||
        typeof note !== "string" || !note.trim() || note.length > 20_000) {
      throw new Error("一条文档批注的内容或位置无效。");
    }
    ids.add(id);
    const item = { id, start, quote, title, text: note, ...(turns?.length ? { turns: validateTurns(turns) } : {}),
      ...(lost ? { lost: true } : {}) };
    return reanchor(text, item);
  });
}

const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"];

// A note block for a picture or a PDF. (A PDF's review is kept with the PDF itself, see pdfReview.)
export function fileNoteBlock(ref) {
  return { id: randomUUID(), kind: "paragraph", noteType: ref.extension === ".pdf" ? "pdf" : "image", text: ref.name,
    attachments: [ref], marks: [], included: true };
}

export function markdownNoteBlock(doc) {
  return { id: randomUUID(), kind: "paragraph", noteType: "md", mdId: doc.id, text: doc.name,
    marks: [], included: true };
}

const reviewHash = /^[\da-f]{64}$/;

function findThread(state, id) {
  return find(state.threads || [], id);
}

export function requireText(value, limit = 60_000) {
  if (typeof value !== "string" || value.length > limit || !value.trim()) {
    throw new Error(`请输入内容，长度限于 ${limit.toLocaleString()} 字符。`);
  }
  return value;
}

function find(items, id) {
  const result = items.find((item) => item.id === id);
  if (!result) throw new Error("这条内容已不存在。");
  return result;
}

function appendMainTurn(state, turn) {
  state.blocks.push({
    id: turn.id, kind: "question", text: turn.question, marks: [], source: turn.source,
    ...(turn.attachments?.length ? { attachments: turn.attachments } : {})
  });
  appendReplyBlocks(state, turn);
}

// One member's answer: its paragraphs share a turnId, and the first one records who spoke.
function appendReplyBlocks(state, turn) {
  const turnId = randomUUID();
  for (const [index, paragraph] of splitReply(turn.answer).entries()) {
    state.blocks.push({ id: randomUUID(), kind: "reply", turnId, text: paragraph, marks: [],
      ...(index === 0 && turn.source ? { source: turn.source } : {}),
      ...(index === 0 && turn.tools?.length ? { tools: turn.tools } : {}) });
  }
}

function checkedAnchor(state, anchor) {
  const { id, text, removed } = find(state.blocks, anchor?.blockId);
  if (removed) throw new Error("原段落已移除。");
  const quote = requireText(anchor?.quote);
  if (!Number.isInteger(anchor?.start) || anchor.start < 0 ||
      text.slice(anchor.start, anchor.start + quote.length) !== quote) {
    throw new Error("选区已改变，请重新选中文字。");
  }
  const label = typeof anchor.label === "string" && anchor.label.length <= 60_000 && anchor.label !== quote
    ? anchor.label : undefined;
  return { blockId: id, start: anchor.start, quote, ...(label ? { label } : {}) };
}

function editBlock(state, id, value) {
  const block = find(state.blocks, id);
  if (typeof value !== "string" || value.length > 160_000) throw new Error("消息最多 160,000 字符。");
  const next = value;
  const attached = [
    ...block.marks,
    ...state.notes.map((note) => note.anchor).filter((anchor) => anchor.blockId === id),
    ...state.branches.map((branch) => branch.anchor).filter((anchor) => anchor.blockId === id)
  ];
  for (const anchor of attached) {
    const offset = findAnchor(next, anchor);
    if (offset !== null) anchor.start = offset;
  }
  block.text = next;
}

function editMessage(state, { ids, text, removed, included }) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) {
    throw new Error("消息范围无效。");
  }
  const indexes = ids.map((id) => state.blocks.findIndex((block) => block.id === id));
  const blocks = indexes.map((index) => state.blocks[index]);
  if (indexes.some((index, offset) => index < 0 || (offset && index !== indexes[0] + offset)) ||
      blocks.some((block, offset) => offset && !sameMessage(blocks[offset - 1], block)) ||
      (blocks[0].kind !== "reply" && blocks.length !== 1)) {
    throw new Error("消息范围无效。");
  }
  if (removed === true) {
    for (const block of blocks) {
      block.removed = true;
      block.text = "";
      block.marks = [];
      delete block.attachments;
    }
    return;
  }
  const first = blocks[0];
  editBlock(state, first.id, text);
  delete first.removed;
  if (typeof included === "boolean" && ["question", "reply", "paragraph"].includes(first.kind)) {
    first.included = included;
  }
  for (const block of blocks.slice(1)) {
    for (const mark of block.marks) {
      const start = findAnchor(first.text, mark);
      if (start !== null) first.marks.push({ ...mark, start, blockId: first.id });
    }
    for (const anchor of [
      ...state.notes.map((note) => note.anchor),
      ...state.branches.map((branch) => branch.anchor)
    ].filter((anchor) => anchor.blockId === block.id)) {
      const start = findAnchor(first.text, anchor);
      if (start !== null) Object.assign(anchor, { blockId: first.id, start });
    }
    block.removed = true;
    block.text = "";
    block.marks = [];
  }
}

// Index just after the message containing afterId; a reply's paragraphs stay together.
// afterId === null inserts at the top, undefined appends at the end.
function insertionIndex(state, afterId) {
  if (afterId === undefined) return state.blocks.length;
  if (afterId === null) return 0;
  let index = state.blocks.findIndex((block) => block.id === afterId);
  if (index < 0) throw new Error("插入位置已改变，请重试。");
  while (state.blocks[index + 1] && sameMessage(state.blocks[index], state.blocks[index + 1])) index += 1;
  return index + 1;
}

// The blocks of one whole message (a reply's paragraphs, or a single question or note).
function messageBlocks(state, ids) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error("消息已改变，请重试。");
  const indexes = ids.map((id) => state.blocks.findIndex((block) => block.id === id));
  const blocks = indexes.map((index) => state.blocks[index]);
  if (indexes.some((index, offset) => index < 0 || (offset && (index !== indexes[0] + offset ||
      !sameMessage(state.blocks[index - 1], state.blocks[index])))) ||
      !["question", "reply", "paragraph"].includes(blocks[0].kind) ||
      (blocks[0].kind !== "reply" && blocks.length !== 1) ||
      sameMessage(state.blocks[indexes[0] - 1], blocks[0]) ||
      sameMessage(blocks.at(-1), state.blocks[indexes.at(-1) + 1])) {
    throw new Error("消息已改变，请重试。");
  }
  return blocks;
}

function convertedMessage(state, blocks) {
  if (blocks.some((block) => block.removed)) throw new Error("消息已改变，请重试。");
  const backup = structuredClone(blocks);
  const attachments = blocks.flatMap((block) => block.attachments || []);
  const text = blocks.map((block) => block.text).join("\n\n").trim() ||
    (attachments.length ? `（附件：${attachments.map((ref) => ref.name).join("、")}）` : "");
  if (!text) throw new Error("这条消息是空的。");
  const speaker = blocks[0].source;
  const author = blocks[0].kind === "question" ? "我的消息" : blocks[0].kind === "paragraph" ? "笔记块"
    : `${speaker?.memberName || (speaker?.provider === "claude" ? "Claude" : speaker?.provider === "gemini" ? "Gemini" : "GPT")} 的回答`;
  blocks[0].conversionBackup = backup;
  for (const block of blocks) {
    block.removed = true;
    block.text = "";
    block.marks = [];
    delete block.attachments;
  }
  return { text, author, attachments, speaker, sourceMessageId: blocks[0].id };
}

function restoreConvertedMessage(state, messageId) {
  const first = find(state.blocks, messageId);
  const backup = first.conversionBackup;
  if (!Array.isArray(backup) || !backup.length) throw new Error("原消息已无法撤销。");
  for (const original of backup) {
    const index = state.blocks.findIndex((block) => block.id === original.id);
    if (index < 0 || !state.blocks[index].removed) throw new Error("原消息已改变，不能撤销。");
    state.blocks[index] = original;
  }
}

// Index of the first block of the message containing beforeId.
function messageStart(state, beforeId) {
  let index = state.blocks.findIndex((block) => block.id === beforeId);
  if (index < 0) throw new Error("笔记块已改变，请重试。");
  while (index > 0 && sameMessage(state.blocks[index - 1], state.blocks[index])) index -= 1;
  return index;
}

export function applyChange(state, action) {
  switch (action.type) {
    case "set-model-session-mode":
      if (!["continue", "manual"].includes(action.mode)) throw new Error("模型会话模式无效。");
      state.modelSessionMode = action.mode;
      state.modelSessions = {};
      state.modelSessionEpoch = (state.modelSessionEpoch || 0) + 1;
      break;
    case "reset-model-sessions":
      state.modelSessions = {};
      state.modelSessionEpoch = (state.modelSessionEpoch || 0) + 1;
      break;
    case "add-shared-block":
      state.blocks.splice(insertionIndex(state, action.afterId), 0, {
        id: randomUUID(), kind: "paragraph", text: requireText(action.text, 160_000).trim(),
        marks: [], included: action.included !== false });
      break;
    case "add-note-images":
      if (!Array.isArray(action.refs) || !action.refs.length || action.refs.length > 6 ||
          action.refs.some((ref) => ![...imageExtensions, ".pdf"].includes(ref.extension))) {
        throw new Error("请选择最多 6 个图片或 PDF 文件。");
      }
      state.blocks.splice(insertionIndex(state, action.afterId), 0, ...action.refs.map(fileNoteBlock));
      break;
    // Side conversations with single members ("分头讨论"). They start private; publishing puts an
    // edited transcript into the chat as a note block, which then goes into everyone's context.
    case "add-thread": {
      if (typeof action.memberId !== "string" || !action.memberId || action.memberId.length > 80) {
        throw new Error("请选择一位成员。");
      }
      state.threads ??= [];
      if (state.threads.length >= 24) throw new Error("最多保留 24 个私聊小窗，请先关掉一些。");
      // origin: the chat message the private conversation started from (its ↗ button).
      const from = action.origin;
      const origin = from && typeof from === "object" && typeof from.text === "string" && from.text.trim() ? {
        messageId: String(from.messageId || "").slice(0, 80), speaker: String(from.speaker || "").slice(0, 24),
        text: from.text.slice(0, 6000)
      } : undefined;
      const thread = { id: randomUUID(), memberId: action.memberId, turns: [], visibility: "private",
        created: Date.now(), ...(origin ? { origin } : {}) };
      state.threads.push(thread);
      // stub: the question of a chat answer moved into this window while it was being written. A
      // folded card stays in the chat where it was asked; it is not part of anyone's context.
      if (typeof action.stub === "string" && action.stub.trim()) {
        state.blocks.push({ id: randomUUID(), kind: "paragraph", noteType: "thread-stub", threadId: thread.id,
          text: action.stub.trim().slice(0, 10_000), marks: [], included: false });
      }
      break;
    }
    case "delete-thread":
      findThread(state, action.id);
      state.threads = state.threads.filter((thread) => thread.id !== action.id);
      for (const block of state.blocks) {
        if (block.noteType === "thread-stub" && block.threadId === action.id) {
          Object.assign(block, { removed: true, text: "", marks: [] });
        }
      }
      break;
    case "edit-thread-turn": {
      const turn = find(findThread(state, action.id).turns, action.turnId);
      if (action.question !== undefined) turn.question = requireText(action.question, 10_000).trim();
      if (action.answer !== undefined) turn.answer = requireText(action.answer, 160_000).trim();
      break;
    }
    case "delete-thread-turn": {
      const thread = findThread(state, action.id);
      find(thread.turns, action.turnId);
      thread.turns = thread.turns.filter((turn) => turn.id !== action.turnId);
      break;
    }
    case "publish-thread": {
      const thread = findThread(state, action.id);
      const text = requireText(action.text, 160_000).trim();
      const source = action.source && typeof action.source === "object" ? {
        memberId: String(action.source.memberId || "").slice(0, 80), memberName: String(action.source.memberName || "").slice(0, 24),
        avatar: String(action.source.avatar || "").slice(0, 30),
        provider: ["gpt", "claude", "gemini"].includes(action.source.provider) ? action.source.provider : "gpt"
      } : undefined;
      const published = thread.publishedBlockId && state.blocks.find((block) => block.id === thread.publishedBlockId && !block.removed);
      if (published) {
        editBlock(state, published.id, text);
        published.included = true;
      } else {
        const block = { id: randomUUID(), kind: "paragraph", noteType: "thread", threadId: thread.id, text, marks: [],
          included: true, ...(source ? { source } : {}) };
        state.blocks.splice(insertionIndex(state, action.afterId), 0, block);
        thread.publishedBlockId = block.id;
      }
      thread.visibility = "public";
      thread.published = Date.now();
      break;
    }
    case "unpublish-thread": {
      const thread = findThread(state, action.id);
      const block = thread.publishedBlockId && state.blocks.find((item) => item.id === thread.publishedBlockId);
      if (block) {
        block.removed = true;
        block.included = false;
        block.text = "";
        block.marks = [];
      }
      delete thread.publishedBlockId;
      thread.visibility = "private";
      break;
    }
    case "move-shared-block": {
      const from = state.blocks.findIndex((block) => block.id === action.id);
      if (from < 0 || state.blocks[from].kind !== "paragraph" || action.beforeId === action.id) {
        throw new Error("笔记块已改变，请重试。");
      }
      const toEnd = action.beforeId === null || action.beforeId === undefined;
      if (!toEnd) messageStart(state, action.beforeId);
      const [moving] = state.blocks.splice(from, 1);
      state.blocks.splice(toEnd ? state.blocks.length : messageStart(state, action.beforeId), 0, moving);
      break;
    }
    // Replace a complete chat message with note blocks in the same place. Keep the old block IDs
    // as hidden tombstones so context cutoffs and historical references remain stable.
    case "convert-reply":
    case "convert-message": {
      const blocks = messageBlocks(state, action.ids);
      if (blocks[0].kind === "paragraph") throw new Error("这已经是笔记块了。");
      const live = blocks.filter((block) => !block.removed);
      const text = live.map((block) => block.text).join("\n\n");
      const attachments = live.flatMap((block) => block.attachments || []);
      const images = attachments.filter((ref) => [".png", ".jpg", ".jpeg", ".webp"].includes(ref.extension));
      const otherFiles = attachments.filter((ref) => !images.includes(ref));
      const notes = images.map((ref) => ({ id: randomUUID(), kind: "paragraph", noteType: "image", text: ref.name,
        attachments: [ref], marks: [], included: true }));
      const textNote = text.trim() || otherFiles.length ? {
        id: randomUUID(), kind: "paragraph",
        text: text.trim() ? requireText(text, 160_000) : `附件：${otherFiles.map((ref) => ref.name).join("、")}`,
        ...(otherFiles.length ? { attachments: otherFiles } : {}), marks: [], included: true
      } : null;
      if (textNote) notes.push(textNote);
      if (!notes.length) throw new Error("这条消息没有可以转成笔记的文字或图片。");
      if (textNote) {
        let offset = 0;
        for (const [index, block] of live.entries()) {
          for (const mark of block.marks || []) {
            textNote.marks.push({ ...mark, blockId: textNote.id, start: offset + mark.start });
          }
          for (const anchor of [
            ...state.notes.map((note) => note.anchor),
            ...state.branches.map((branch) => branch.anchor)
          ].filter((anchor) => anchor.blockId === block.id)) {
            anchor.blockId = textNote.id;
            anchor.start += offset;
          }
          offset += block.text.length + (index < live.length - 1 ? 2 : 0);
        }
      }
      // Older edited messages can still have notes or branches pointing at a removed paragraph.
      // Reattach those references so the converted message never leaves an orphaned chat bubble.
      const oldIds = new Set(blocks.map((block) => block.id));
      for (const anchor of [
        ...state.notes.map((note) => note.anchor),
        ...state.branches.map((branch) => branch.anchor)
      ]) {
        if (oldIds.has(anchor.blockId)) {
          anchor.blockId = (textNote || notes[0]).id;
          anchor.start = 0;
        }
      }
      state.blocks.splice(insertionIndex(state, blocks.at(-1).id), 0, ...notes);
      if (state.context?.ids?.includes(blocks[0].id)) {
        state.context.ids = [...state.context.ids.filter((id) => id !== blocks[0].id),
          ...notes.map((note) => note.id)];
      }
      for (const block of blocks) {
        block.removed = true;
        block.included = false;
        block.text = "";
        block.marks = [];
        delete block.attachments;
      }
      break;
    }
    // Move a message out of the conversation into a margin annotation on the nearest other message.
    case "message-to-annotation": {
      const blocks = messageBlocks(state, action.ids);
      const own = new Set(blocks.map((block) => block.id));
      // Where it hangs: the passage or message the user picked, else the nearest other message.
      let anchor;
      if (action.anchor) {
        anchor = checkedAnchor(state, action.anchor);
        if (own.has(anchor.blockId)) throw new Error("批注不能挂在它自己这条消息上，请选别的消息。");
      } else {
        const first = state.blocks.indexOf(blocks[0]);
        const usable = (block) => block && !own.has(block.id) && !block.removed && block.text.trim();
        const target = state.blocks.slice(0, first).reverse().find(usable) ?? state.blocks.slice(first).find(usable);
        if (!target) throw new Error("没有其他消息可以挂这条批注。");
        const start = target.text.search(/\S/);
        anchor = { blockId: target.id, start, quote: target.text.slice(start).split(/\r?\n/, 1)[0].slice(0, 40) };
      }
      const { text, author, attachments, speaker, sourceMessageId } = convertedMessage(state, blocks);
      state.notes.push({ id: randomUUID(), anchor, text: requireText(text, 160_000),
        author, pinned: false, sourceMessageId,
        ...(attachments.length ? { attachments } : {}), ...(speaker ? { source: speaker } : {}) });
      break;
    }
    case "undo-message-to-annotation": {
      const note = find(state.notes, action.id);
      if (!note.sourceMessageId) throw new Error("这条批注不是从消息转来的。");
      if (note.turns?.length) throw new Error("这条批注已有追问，请先处理追问再撤销。");
      restoreConvertedMessage(state, note.sourceMessageId);
      state.notes = state.notes.filter((item) => item.id !== note.id);
      if (state.context?.notes) state.context.notes = state.context.notes.filter((id) => id !== note.id);
      state.mainMemoryIds = (state.mainMemoryIds || []).filter((id) => id !== note.id);
      for (const branch of state.branches) branch.memoryIds = branch.memoryIds.filter((id) => id !== note.id);
      break;
    }
    case "add-blocks":
      state.blocks.push(...splitReply(requireText(action.text)).map((text) => ({
        id: randomUUID(), kind: "paragraph", text, marks: []
      })));
      break;
    case "edit-document":
      state.title = requireText(action.title, 160).trim();
      for (const { id, text, removed, included } of action.blocks || []) {
        const block = find(state.blocks, id);
        if (removed === true) {
          block.removed = true;
          block.text = "";
          block.marks = [];
          delete block.attachments;
          continue;
        }
        editBlock(state, id, text);
        if (typeof included === "boolean" && ["question", "reply"].includes(block.kind)) block.included = included;
      }
      for (const message of action.messages || []) editMessage(state, message);
      break;
    case "mark": {
      if (!["highlight", "underline"].includes(action.style)) throw new Error("未知的标记类型。");
      const anchor = checkedAnchor(state, action.anchor);
      const block = find(state.blocks, anchor.blockId);
      const existing = block.marks.findIndex((mark) =>
        mark.style === action.style && mark.start === anchor.start && mark.quote === anchor.quote);
      if (existing >= 0) block.marks.splice(existing, 1);
      else block.marks.push({ ...anchor, style: action.style });
      break;
    }
    case "add-note": {
      const branch = action.branchId ? find(state.branches, action.branchId) : null;
      const anchor = branch ? { ...branch.anchor } : checkedAnchor(state, action.anchor);
      const source = action.turnId ? find(branch.turns, action.turnId).source : undefined;
      state.notes.push({
        id: randomUUID(), anchor, text: requireText(action.text).trim(),
        author: branch ? (source?.provider === "claude" ? "Claude 摘录" : "Codex 摘录") : "我的批注",
        pinned: false
      });
      break;
    }
    case "edit-note":
      find(state.notes, action.id).text = requireText(action.text).trim();
      break;
    case "pin-note": {
      const note = find(state.notes, action.id);
      note.pinned = !note.pinned;
      if (!note.pinned) {
        state.mainMemoryIds = (state.mainMemoryIds || []).filter((id) => id !== note.id);
        for (const branch of state.branches) branch.memoryIds = branch.memoryIds.filter((id) => id !== note.id);
      }
      break;
    }
    case "delete-note":
      state.notes = state.notes.filter((note) => note.id !== action.id);
      if (state.context?.notes) state.context.notes = state.context.notes.filter((id) => id !== action.id);
      state.mainMemoryIds = (state.mainMemoryIds || []).filter((id) => id !== action.id);
      for (const branch of state.branches) branch.memoryIds = branch.memoryIds.filter((id) => id !== action.id);
      break;
    case "main-memory": {
      const note = find(state.notes, action.noteId);
      if (!note.pinned) throw new Error("请先把批注固定为记忆。");
      state.mainMemoryIds = action.enabled
        ? [...new Set([...(state.mainMemoryIds || []), note.id])]
        : (state.mainMemoryIds || []).filter((id) => id !== note.id);
      break;
    }
    case "create-branch": {
      const anchor = checkedAnchor(state, action.anchor);
      const block = find(state.blocks, anchor.blockId);
      state.branches.push({
        id: randomUUID(), anchor, context: block.text, memoryIds: [],
        position: null, turns: []
      });
      break;
    }
    case "memory": {
      const branch = find(state.branches, action.id);
      const note = find(state.notes, action.noteId);
      if (!note.pinned) throw new Error("请先把批注固定为记忆。");
      branch.memoryIds = action.enabled
        ? [...new Set([...branch.memoryIds, note.id])]
        : branch.memoryIds.filter((id) => id !== note.id);
      break;
    }
    case "move-branch": {
      const { x, y } = action.position;
      if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value < 100_000)) {
        throw new Error("画布位置无效。");
      }
      find(state.branches, action.id).position = { x, y };
      break;
    }
    case "delete-branch":
      state.branches = state.branches.filter((branch) => branch.id !== action.id);
      break;
    case "clear-work-dir":
      delete state.workDir;
      break;
    // Use only these messages (plus anything newer) as the main chat's context.
    // ids: the chosen messages (null = all earlier messages); notes: annotations to include, which
    // otherwise stay out of the main chat's context.
    case "set-context": {
      const starts = new Set(messageGroups(state.blocks).map((group) => group.blocks[0].id));
      const noteIds = new Set(state.notes.map((note) => note.id));
      const ids = action.ids === null ? null : action.ids;
      const notes = action.noteIds ?? [];
      if ((ids !== null && (!Array.isArray(ids) || ids.length > 2000 || ids.some((id) => !starts.has(id)))) ||
          !Array.isArray(notes) || notes.some((id) => !noteIds.has(id))) {
        throw new Error("所选消息已改变，请重新选择。");
      }
      if (ids === null && !notes.length) delete state.context;
      else state.context = { ids: ids && [...new Set(ids)], notes: [...new Set(notes)], cutoff: state.blocks.at(-1)?.id };
      break;
    }
    case "clear-context":
      delete state.context;
      break;
    case "edit-answer": {
      const branch = find(state.branches, action.id);
      find(branch.turns, action.turnId).answer = requireText(action.text);
      break;
    }
    default:
      throw new Error("无法保存此操作。");
  }
  return state;
}

export class NotebookStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notebook (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notebook_documents (
        id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notebook_library (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notebook_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pdf_reviews (
        hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS child_chats (
        key TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        parent_notebook TEXT,
        kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS child_chats_parent ON child_chats(parent_notebook);
      CREATE TABLE IF NOT EXISTS md_documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT,
        text TEXT NOT NULL,
        data TEXT NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_pdf_review (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        page INTEGER NOT NULL
      );
    `);
    this.select = this.db.prepare("SELECT snapshot FROM notebook_documents WHERE id = ?");
    this.update = this.db.prepare("UPDATE notebook_documents SET snapshot = ?, updated = ? WHERE id = ?");
    this.insert = this.db.prepare("INSERT INTO notebook_documents VALUES (?, ?, ?)");
    if (!this.db.prepare("SELECT active FROM notebook_library WHERE id = 1").get()) {
      const row = this.db.prepare("SELECT snapshot FROM notebook WHERE id = 1").get();
      const state = row ? JSON.parse(row.snapshot) : initialNotebook();
      state.id ||= randomUUID();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.insert.run(state.id, JSON.stringify(state), Date.now());
        this.db.prepare("INSERT INTO notebook_library VALUES (1, ?)").run(state.id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  activeId() {
    return this.db.prepare("SELECT active FROM notebook_library WHERE id = 1").get().active;
  }

  read(id = this.activeId()) {
    const row = this.select.get(id);
    if (!row) throw new Error("找不到这本笔记。");
    return this.#fill(JSON.parse(row.snapshot));
  }

  // ---- child chats --------------------------------------------------------------------------

  // The annotation follow-ups, branches and private windows of a chat, with their child chat keys.
  #conversations(state) {
    const notebookId = state.id;
    return [
      ...(state.notes || []).map((note) => [note, childKey.note(notebookId, note.id), { kind: "note", notebookId,
        noteId: note.id, title: `批注追问 · ${label(note.anchor?.label || note.anchor?.quote || note.text)}` }]),
      ...(state.branches || []).map((branch) => [branch, childKey.branch(notebookId, branch.id), { kind: "branch",
        notebookId, branchId: branch.id, title: `分支 · ${label(branch.anchor?.label || branch.anchor?.quote)}` }]),
      ...(state.threads || []).map((thread) => [thread, childKey.thread(notebookId, thread.id), { kind: "thread",
        notebookId, threadId: thread.id, memberId: thread.memberId, title: "私聊" }])
    ];
  }

  // Turns come from the child chat; a list still stored inline (older data) is kept and moved
  // into a child chat by the next write.
  #fill(state) {
    const children = new Map(this.db.prepare(`SELECT c.key, d.snapshot FROM child_chats c
      JOIN notebook_documents d ON d.id = c.notebook_id WHERE c.parent_notebook = ?`).all(state.id)
      .map(({ key, snapshot }) => [key, JSON.parse(snapshot)]));
    // Windows refresh a chat when its revision grows; a reply in one of its child chats counts.
    for (const child of children.values()) state.revision = (state.revision || 0) + (child.revision || 0);
    const signatures = new Map();
    for (const [item, key, parent] of this.#conversations(state)) {
      const child = children.get(key);
      if (child) item.turns = chatTurns(child);
      else if (parent.kind !== "note") item.turns ??= [];
      signatures.set(key, !child && item.turns?.length ? "inline" : JSON.stringify(item.turns ?? []));
    }
    filledLists.set(state, signatures);
    // A chat without members of its own talks with those of the chat it grew from (for a review's
    // chats: the chat the review was last opened from). Not stored; see #stored.
    const inherited = state.members?.length ? null : this.#inheritedRoster(state);
    if (inherited) state.inherited = inherited;
    else delete state.inherited;
    return state;
  }

  #inheritedRoster(state) {
    const seen = new Set([state.id]);
    let parent = state.parent;
    for (let step = 0; parent && step < 12; step += 1) {
      const id = parent.notebookId || parent.rosterNotebookId;
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const row = this.select.get(id);
      if (!row) return null;
      const next = JSON.parse(row.snapshot);
      if (next.members?.length) return { members: next.members, defaultMember: next.defaultMember };
      parent = next.parent;
    }
    return null;
  }

  // Conversation lists that changed are written into their child chats; child chats whose
  // annotation, branch or window is gone are removed.
  #absorb(state) {
    const signatures = filledLists.get(state) ?? new Map();
    const kept = new Set();
    for (const [item, key, parent] of this.#conversations(state)) {
      kept.add(key);
      if (!Array.isArray(item.turns)) continue;
      const signature = JSON.stringify(item.turns);
      if (signatures.get(key) === signature) continue;
      this.syncChildTurns(key, parent, item.turns, { prune: true });
      signatures.set(key, signature);
    }
    filledLists.set(state, signatures);
    for (const { key } of this.db.prepare("SELECT key FROM child_chats WHERE parent_notebook = ?").all(state.id)) {
      if (!kept.has(key)) this.deleteChildChat(key);
    }
  }

  #stored(state) {
    return JSON.stringify({ ...state, inherited: undefined, notes: withoutTurns(state.notes) ?? state.notes,
      branches: withoutTurns(state.branches) ?? state.branches, ...(state.threads ? { threads: withoutTurns(state.threads) } : {}) });
  }

  #insertChat(state) {
    this.insert.run(state.id, this.#stored(state), Date.now());
    this.#absorb(state);
  }

  childChat(key) {
    const row = this.db.prepare("SELECT notebook_id FROM child_chats WHERE key = ?").get(key);
    if (!row) return null;
    const found = this.select.get(row.notebook_id);
    if (!found) {
      this.db.prepare("DELETE FROM child_chats WHERE key = ?").run(key);
      return null;
    }
    return this.#fill(JSON.parse(found.snapshot));
  }

  // parent: { kind, title, notebookId?, … } — where the conversation grew from.
  ensureChildChat(key, parent) {
    const existing = this.childChat(key);
    if (existing) return existing;
    if (!childKinds[parent?.kind]) throw new Error("对话来源无效。");
    const state = { id: randomUUID(), title: requireText(parent.title || childKinds[parent.kind], 160).trim(),
      blocks: [], notes: [], branches: [], parent: { ...parent, key } };
    this.insert.run(state.id, JSON.stringify(state), Date.now());
    this.db.prepare("INSERT INTO child_chats VALUES (?, ?, ?, ?)").run(key, state.id, parent.notebookId || null, parent.kind);
    return this.#fill(state);
  }

  // The child chat of a conversation, made (empty) if it has none yet; returns its id.
  // rosterId: the chat a review was opened from; its chats talk with that chat's members.
  openChildChat({ kind, notebookId, itemId, hash, mdId, commentId, rosterId }) {
    const id = this.#openChildChat({ kind, notebookId, itemId, hash, mdId, commentId });
    if (!kind.startsWith("pdf-") && !kind.startsWith("md-")) return id;
    const chat = this.read(id);
    if (typeof rosterId === "string" && rosterId !== id && rosterId !== chat.parent.rosterNotebookId &&
        this.select.get(rosterId)) {
      chat.parent = { ...chat.parent, rosterNotebookId: rosterId };
      this.write(chat);
    }
    return id;
  }

  #openChildChat({ kind, notebookId, itemId, hash, mdId, commentId }) {
    if (kind === "note" || kind === "branch" || kind === "thread") {
      const found = this.#conversations(this.read(notebookId)).find(([item, , parent]) => parent.kind === kind && item.id === itemId);
      if (!found) throw new Error("这段对话已不存在。");
      return this.ensureChildChat(found[1], found[2]).id;
    }
    const pdf = kind === "pdf-chat" || kind === "pdf-comment";
    const review = pdf ? this.pdfReview(hash) : this.mdDocument(mdId);
    if (!review) throw new Error("找不到这份审阅。");
    const id = pdf ? hash : mdId;
    const keys = this.#reviewKeys(pdf ? "pdf" : "md", id);
    if (kind.endsWith("-chat")) {
      return this.ensureChildChat(keys.chat, { kind, ...keys.parent, title: `全文对话 · ${label(review.name, 60)}` }).id;
    }
    const comment = review.comments.find((item) => item.id === commentId);
    if (!comment) throw new Error("这条批注还没保存或已被删除。");
    return this.ensureChildChat(keys.comment(comment.id), { kind, ...keys.parent, commentId: comment.id,
      title: `${pdf ? "PDF" : "文档"}批注追问 · ${label(comment.title || comment.quote)}` }).id;
  }

  childTurns(key) {
    const chat = this.childChat(key);
    return chat ? chatTurns(chat) : null;
  }

  syncChildTurns(key, parent, turns, { prune = false } = {}) {
    let chat = this.childChat(key);
    if (!chat && !turns?.length) return null;
    chat ??= this.ensureChildChat(key, parent);
    if (syncTurns(chat, turns || [], { prune })) this.write(chat);
    return chat;
  }

  appendChildTurn(key, parent, turn) {
    const chat = this.ensureChildChat(key, parent);
    appendTurn(chat, turn);
    return this.write(chat);
  }

  // ---- relations: what grew out of a chat, as a tree (the graph / outline view) ------------------
  // A node with a conversation says how to open it (`open`, what openChildChat takes) and its chat
  // id once it has one; the annotations, branches and windows of that chat hang below it, and so
  // on down. PDFs in a chat are listed by attachment (main.mjs adds their reviews with reviewTree).
  chatTree(rootId, { depth = 8 } = {}) {
    const state = this.read(rootId);
    const seen = new Set([state.id]);
    return { kind: "chat", title: state.title, chatId: state.id, turns: chatTurns(state).length,
      updated: this.#updated(state.id), parent: state.parent || null, children: this.#treeOf(state, 1, depth, seen) };
  }

  reviewTree(kind, id, { depth = 8, seen = new Set() } = {}) {
    const pdf = kind === "pdf";
    const review = pdf ? this.pdfReview(id) : this.mdDocument(id);
    if (!review) return null;
    const keys = this.#reviewKeys(kind, id);
    const where = pdf ? { hash: id } : { mdId: id };
    return {
      kind, title: review.name, updated: review.updated, ...where, comments: review.comments.length,
      children: [
        this.#chatNode(keys.chat, { kind: `${kind}-chat`, title: pdf ? "整份 PDF 的讨论" : "整篇文档的讨论", turns: review.chat.length,
          open: { kind: `${kind}-chat`, ...where } }, 1, depth, seen),
        ...review.comments.map((comment) => this.#chatNode(keys.comment(comment.id), {
          kind: `${kind}-comment`, title: plain(comment.title || comment.text, 60) || "批注", quote: label(comment.quote, 120),
          text: plain(comment.text, 200), page: comment.page, turns: comment.turns?.length || 0,
          open: { kind: `${kind}-comment`, ...where, commentId: comment.id } }, 1, depth, seen))
      ]
    };
  }

  #updated(id) {
    return this.db.prepare("SELECT updated FROM notebook_documents WHERE id = ?").get(id)?.updated || 0;
  }

  #treeOf(state, level, depth, seen) {
    const nodes = this.#conversations(state).map(([item, key, parent]) => {
      const quote = label(item.anchor?.label || item.anchor?.quote, 120);
      const title = parent.kind === "note" ? plain(item.title || item.text, 60) || "批注"
        : parent.kind === "branch" ? quote || "分支" : "私聊";
      return this.#chatNode(key, { kind: parent.kind, title, quote, text: parent.kind === "note" ? plain(item.text, 200) : "",
        memberId: item.memberId || "", turns: item.turns?.length || 0,
        open: { kind: parent.kind, notebookId: state.id, itemId: item.id } }, level, depth, seen);
    });
    const pdfs = new Map();
    for (const block of state.blocks || []) {
      const ref = block.noteType === "pdf" ? block.attachments?.[0] : null;
      if (ref?.id && !pdfs.has(ref.id)) {
        pdfs.set(ref.id, { kind: "pdf", title: ref.name || block.text || "PDF", attachmentId: ref.id, blockId: block.id, attachment: ref, children: [] });
      }
    }
    return [...nodes, ...pdfs.values()];
  }

  #chatNode(key, node, level, depth, seen) {
    const chat = this.childChat(key);
    const fresh = chat && !seen.has(chat.id);
    if (fresh) seen.add(chat.id);
    return { ...node, chatId: chat?.id || null, updated: chat ? this.#updated(chat.id) : 0,
      children: fresh && level < depth ? this.#treeOf(chat, level + 1, depth, seen) : [] };
  }

  // A child chat goes with whatever it grew from, together with its own child chats.
  deleteChildChat(key) {
    const row = this.db.prepare("SELECT notebook_id FROM child_chats WHERE key = ?").get(key);
    this.db.prepare("DELETE FROM child_chats WHERE key = ?").run(key);
    if (row) this.#deleteChildrenOf(row.notebook_id, true);
  }

  #deleteChildrenOf(notebookId, itself = false) {
    for (const { key } of this.db.prepare("SELECT key FROM child_chats WHERE parent_notebook = ?").all(notebookId)) {
      this.deleteChildChat(key);
    }
    if (itself) this.db.prepare("DELETE FROM notebook_documents WHERE id = ?").run(notebookId);
  }

  #deleteChildrenByPrefix(prefix, keep = new Set()) {
    for (const { key } of this.db.prepare("SELECT key FROM child_chats WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix)) {
      if (!keep.has(key)) this.deleteChildChat(key);
    }
  }

  // Every chat that still keeps a conversation inline moves it into child chats (older data).
  needsConversationMove() {
    return this.db.prepare(`SELECT 1 FROM notebook_documents WHERE snapshot LIKE '%"turns":[{%' LIMIT 1`).get() ||
      this.db.prepare(`SELECT 1 FROM pdf_reviews WHERE data LIKE '%"turns":[{%' OR data LIKE '%"chat":[{%' LIMIT 1`).get() ||
      this.db.prepare(`SELECT 1 FROM md_documents WHERE data LIKE '%"turns":[{%' OR data LIKE '%"chat":[{%' LIMIT 1`).get();
  }

  moveConversations() {
    for (const { id } of this.db.prepare("SELECT id FROM notebook_documents").all()) {
      const state = this.read(id);
      if (this.#conversations(state).some(([item]) => item.turns?.length)) this.write(state);
    }
    for (const { hash, name } of this.db.prepare("SELECT hash, name FROM pdf_reviews").all()) {
      const review = this.pdfReview(hash);
      this.savePdfReview(hash, name, review);
    }
    for (const { id } of this.db.prepare("SELECT id FROM md_documents").all()) {
      const doc = this.mdDocument(id);
      this.saveMdDocument(id, doc);
    }
  }

  readAll() {
    return this.db.prepare("SELECT snapshot FROM notebook_documents").all().map(({ snapshot }) => JSON.parse(snapshot));
  }

  // Child chats are reached from where they grew, not listed among the sessions.
  library() {
    const items = this.db.prepare(`SELECT id, json_extract(snapshot, '$.title') AS title,
      json_extract(snapshot, '$.folderId') AS folderId
      FROM notebook_documents WHERE json_extract(snapshot, '$.parent') IS NULL ORDER BY updated DESC, rowid DESC`).all();
    const folders = this.db.prepare("SELECT id, name FROM notebook_folders ORDER BY created, rowid").all();
    return { active: this.activeId(), items, folders };
  }

  checkedFolder(id) {
    if (id === null || id === undefined || id === "") return null;
    if (typeof id !== "string" || !this.db.prepare("SELECT 1 FROM notebook_folders WHERE id = ?").get(id)) {
      throw new Error("这个主题已不存在。");
    }
    return id;
  }

  createFolder(name) {
    const label = requireText(name, 80).trim();
    if (this.db.prepare("SELECT 1 FROM notebook_folders WHERE name = ? COLLATE NOCASE").get(label)) {
      throw new Error("同名主题已经存在。");
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO notebook_folders VALUES (?, ?, ?)").run(id, label, Date.now());
    return { folderId: id, ...this.library() };
  }

  renameFolder(id, name) {
    this.checkedFolder(id);
    const label = requireText(name, 80).trim();
    if (this.db.prepare("SELECT 1 FROM notebook_folders WHERE name = ? COLLATE NOCASE AND id != ?").get(label, id)) {
      throw new Error("同名主题已经存在。");
    }
    this.db.prepare("UPDATE notebook_folders SET name = ? WHERE id = ?").run(label, id);
    return this.library();
  }

  deleteFolder(id) {
    this.checkedFolder(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of this.library().items.filter((item) => item.folderId === id)) {
        const state = this.read(item.id);
        delete state.folderId;
        this.write(state);
      }
      this.db.prepare("DELETE FROM notebook_folders WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.library();
  }

  renameNotebook(id, title) {
    const state = this.read(id);
    state.title = requireText(title, 160).trim();
    this.write(state);
    return { state: this.read(), ...this.library() };
  }

  moveNotebook(id, folderId) {
    const state = this.read(id);
    const folder = this.checkedFolder(folderId);
    if (folder) state.folderId = folder;
    else delete state.folderId;
    this.write(state);
    return { state: this.read(), ...this.library() };
  }

  deleteNotebook(id) {
    this.read(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.library().items.length === 1) {
        const fresh = initialNotebook();
        fresh.id = randomUUID();
        this.insert.run(fresh.id, JSON.stringify(fresh), Date.now());
      }
      this.db.prepare("DELETE FROM notebook_documents WHERE id = ?").run(id);
      this.#deleteChildrenOf(id);
      if (this.activeId() === id) {
        const replacement = this.db.prepare(`SELECT id FROM notebook_documents WHERE json_extract(snapshot, '$.parent') IS NULL
          ORDER BY updated DESC, rowid DESC LIMIT 1`).get();
        this.db.prepare("UPDATE notebook_library SET active = ? WHERE id = 1").run(replacement.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { state: this.read(), ...this.library() };
  }

  // A PDF's review, kept by the PDF's content (SHA-256) and shared by every chat that shows it:
  // annotations with their follow-ups, the whole-document conversation, and the page last read.
  // ---- conversations of reviews (PDF and Markdown) -------------------------------------------
  // A review's whole-document chat and each annotation's follow-up are child chats too. Reading
  // fills them in; saving only adds turns (the page showing a review may hold an older copy, so
  // nothing is removed from a chat that way) and drops the child chat of a deleted annotation.
  #reviewKeys(kind, id) {
    return kind === "pdf"
      ? { chat: childKey.pdfChat(id), comment: (commentId) => childKey.pdfComment(id, commentId), prefix: `pdf-comment:${id}:`,
        parent: { hash: id } }
      : { chat: childKey.mdChat(id), comment: (commentId) => childKey.mdComment(id, commentId), prefix: `md-comment:${id}:`,
        parent: { mdId: id } };
  }

  #reviewChats(kind, id, { comments = [], chat = [] }) {
    const keys = this.#reviewKeys(kind, id);
    return {
      comments: comments.map((comment) => {
        const turns = this.childTurns(keys.comment(comment.id));
        return turns ? { ...comment, turns } : comment;
      }),
      chat: this.childTurns(keys.chat) ?? chat
    };
  }

  #absorbReview(kind, id, name, comments, chat) {
    const keys = this.#reviewKeys(kind, id);
    const word = kind === "pdf" ? "PDF" : "文档";
    for (const comment of comments) {
      if (!comment.turns?.length) continue;
      this.syncChildTurns(keys.comment(comment.id), { kind: `${kind}-comment`, ...keys.parent, commentId: comment.id,
        title: `${word}批注追问 · ${label(comment.title || comment.quote)}` }, comment.turns);
    }
    if (chat?.length) this.syncChildTurns(keys.chat, { kind: `${kind}-chat`, ...keys.parent, title: `全文对话 · ${label(name, 60)}` }, chat);
    this.#deleteChildrenByPrefix(keys.prefix, new Set(comments.map((comment) => keys.comment(comment.id))));
    return { comments: withoutTurns(comments), chat: [] };
  }

  pdfReview(hash) {
    if (!reviewHash.test(hash || "")) throw new Error("审阅记录无效。");
    const row = this.db.prepare("SELECT name, data, updated FROM pdf_reviews WHERE hash = ?").get(hash);
    if (!row) return null;
    const data = JSON.parse(row.data);
    return { hash, name: row.name, updated: row.updated, ...data, ...this.#reviewChats("pdf", hash, data) };
  }

  savePdfReview(hash, name, { comments = [], chat = [], page = 1 } = {}) {
    if (!reviewHash.test(hash || "")) throw new Error("审阅记录无效。");
    const title = requireText(name, 250).trim();
    const kept = this.#absorbReview("pdf", hash, title, validateComments(comments), validateTurns(chat));
    const data = { ...kept, page: Number.isInteger(page) && page > 0 ? page : 1 };
    this.db.prepare(`INSERT INTO pdf_reviews VALUES (?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET name = excluded.name, data = excluded.data, updated = excluded.updated`)
      .run(hash, title, JSON.stringify(data), Date.now());
    return this.pdfReview(hash);
  }

  // Where the reader is; does not move the review up the list.
  pdfReviewPage(hash, page) {
    const row = this.db.prepare("SELECT data FROM pdf_reviews WHERE hash = ?").get(hash);
    if (!row || !Number.isInteger(page) || page < 1) return;
    this.db.prepare("UPDATE pdf_reviews SET data = ? WHERE hash = ?").run(JSON.stringify({ ...JSON.parse(row.data), page }), hash);
  }

  pdfReviews() {
    return this.db.prepare("SELECT hash, name, data, updated FROM pdf_reviews ORDER BY updated DESC").all()
      .map(({ hash, name, data, updated }) => {
        const { comments = [], chat = [], page = 1 } = JSON.parse(data);
        return { hash, name, updated, page, comments: comments.length,
          chat: (this.childTurns(childKey.pdfChat(hash)) ?? chat).length };
      });
  }

  // Files attached to questions inside reviews (they must not be cleaned up as unused).
  pdfReviewAttachments() {
    return this.db.prepare("SELECT hash FROM pdf_reviews").all().flatMap(({ hash }) => {
      const { comments = [], chat = [] } = this.pdfReview(hash);
      return [...chat, ...comments.flatMap((item) => item.turns || [])].flatMap((turn) => turn.attachments || []);
    });
  }

  removePdfReview(hash) {
    if (!reviewHash.test(hash || "")) throw new Error("审阅记录无效。");
    this.db.prepare("DELETE FROM pdf_reviews WHERE hash = ?").run(hash);
    this.deleteChildChat(childKey.pdfChat(hash));
    this.#deleteChildrenByPrefix(`pdf-comment:${hash}:`);
  }

  // ---- Markdown documents --------------------------------------------------------------------
  // The text lives here (saved as you type); path is the .md file it came from, written back on
  // request. data: { comments, chat, fileHash (the file as last read or written), unsynced, mode }.
  mdDocument(id) {
    if (!mdId.test(id || "")) throw new Error("文档记录无效。");
    const row = this.db.prepare("SELECT name, path, text, data, updated FROM md_documents WHERE id = ?").get(id);
    if (!row) return null;
    const data = JSON.parse(row.data);
    const { fileHash = "", unsynced = false, mode = "preview" } = data;
    const { comments, chat } = this.#reviewChats("md", id, data);
    return { id, name: row.name, path: row.path || "", text: row.text, comments, chat, fileHash, unsynced, mode,
      updated: row.updated };
  }

  mdDocumentByPath(path) {
    const row = this.db.prepare("SELECT id FROM md_documents WHERE lower(path) = lower(?)").get(path);
    return row ? this.mdDocument(row.id) : null;
  }

  saveMdDocument(id, { name, path = "", text, comments = [], chat = [], fileHash = "", unsynced = false, mode = "preview" }) {
    if (!mdId.test(id || "")) throw new Error("文档记录无效。");
    if (typeof text !== "string" || text.length > mdTextLimit) throw new Error("文档太大（上限 5 MB）。");
    if (typeof path !== "string" || path.length > 2000 || (path && !isAbsolute(path))) throw new Error("文件路径无效。");
    const title = requireText(name, 250).trim();
    const kept = this.#absorbReview("md", id, title, validateMdComments(comments, text), validateTurns(chat));
    const data = { ...kept, fileHash: String(fileHash).slice(0, 64),
      unsynced: Boolean(unsynced), mode: ["preview", "split", "source"].includes(mode) ? mode : "preview" };
    this.db.prepare(`INSERT INTO md_documents VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, text = excluded.text,
        data = excluded.data, updated = excluded.updated`)
      .run(id, requireText(name, 250).trim(), path || null, text, JSON.stringify(data), Date.now());
    return this.mdDocument(id);
  }

  mdDocuments() {
    return this.db.prepare("SELECT id, name, path, data, updated FROM md_documents ORDER BY updated DESC").all()
      .map(({ id, name, path, data, updated }) => {
        const { comments = [], chat = [], unsynced = false } = JSON.parse(data);
        return { id, name, path: path || "", updated, unsynced, comments: comments.length,
          chat: (this.childTurns(childKey.mdChat(id)) ?? chat).length };
      });
  }

  // Files attached to questions about documents (they must not be cleaned up as unused).
  mdDocumentAttachments() {
    return this.db.prepare("SELECT id FROM md_documents").all().flatMap(({ id }) => {
      const { comments = [], chat = [] } = this.mdDocument(id);
      return [...chat, ...comments.flatMap((item) => item.turns || [])].flatMap((turn) => turn.attachments || []);
    });
  }

  removeMdDocument(id) {
    if (!mdId.test(id || "")) throw new Error("文档记录无效。");
    this.db.prepare("DELETE FROM md_documents WHERE id = ?").run(id);
    this.deleteChildChat(childKey.mdChat(id));
    this.#deleteChildrenByPrefix(`md-comment:${id}:`);
  }

  open(id) {
    const state = this.read(id);
    this.db.prepare("UPDATE notebook_library SET active = ? WHERE id = 1").run(state.id);
    return { state, ...this.library() };
  }

  create(title, { origin, turns = [], folderId, blocks = [] } = {}) {
    const state = { id: randomUUID(), title: requireText(title, 160).trim(), blocks: [...blocks], notes: [], branches: [] };
    const folder = this.checkedFolder(folderId);
    if (folder) state.folderId = folder;
    if (origin) state.origin = origin;
    for (const turn of turns) appendMainTurn(state, { ...turn, id: randomUUID() });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertChat(state);
      const result = this.open(state.id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createFromMessages(sourceId, selectedIds) {
    const source = this.read(sourceId);
    if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 500) {
      throw new Error("请先选择要带入新聊天的消息。");
    }
    const selected = new Set(selectedIds);
    const groups = messageGroups(source.blocks);
    const valid = new Set(groups.map((group) => group.blocks[0].id));
    if ([...selected].some((id) => !valid.has(id))) throw new Error("所选消息已改变，请重新选择。");
    const copied = new Set();
    let question;
    for (const group of groups) {
      if (group.kind === "question") question = group;
      if (!selected.has(group.blocks[0].id)) continue;
      if (group.kind === "reply" && question) question.blocks.forEach((block) => copied.add(block.id));
      group.blocks.forEach((block) => copied.add(block.id));
    }
    const blocks = structuredClone(source.blocks.filter((block) => copied.has(block.id)));
    const notes = structuredClone(source.notes.filter((note) => copied.has(note.anchor.blockId)));
    const noteIds = new Set(notes.map((note) => note.id));
    const branches = structuredClone(source.branches.filter((branch) => copied.has(branch.anchor.blockId)));
    for (const branch of branches) branch.memoryIds = branch.memoryIds.filter((id) => noteIds.has(id));
    const context = blocks.filter((block) => block.kind === "paragraph" && !block.removed)
      .map((block) => block.text).join("\n\n");
    const state = {
      id: randomUUID(), title: `${source.title.slice(0, 146)} · 选中对话`, blocks, notes, branches,
      ...(source.folderId ? { folderId: source.folderId } : {}),
      mainMemoryIds: (source.mainMemoryIds || []).filter((id) => noteIds.has(id)),
      ...(source.workDir ? { workDir: source.workDir } : {}),
      ...(source.members?.length ? { members: structuredClone(source.members), defaultMember: source.defaultMember } : {}),
      ...(context ? { origin: { kind: "selection", reference: source.title, text: context } } : {})
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertChat(state);
      const result = this.open(state.id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  change(action, id) {
    const state = applyChange(this.read(id), action);
    return this.write(state);
  }

  addMarkdownBlock(notebookId, mdId, afterId) {
    const doc = this.mdDocument(mdId);
    if (!doc) throw new Error("Markdown 文档不存在。");
    const state = this.read(notebookId);
    state.blocks.splice(insertionIndex(state, afterId), 0, markdownNoteBlock(doc));
    return this.write(state);
  }

  moveMessageToPdfAnnotation(notebookId, ids, hash, anchor) {
    const state = this.read(notebookId);
    if (state.parent?.kind !== "pdf-chat" || state.parent.hash !== hash) throw new Error("只能把这份 PDF 全文对话里的消息挂到该 PDF 上。");
    const review = this.pdfReview(hash);
    if (!review) throw new Error("PDF 审阅不存在。");
    const blocks = messageBlocks(state, ids);
    const { text, author, sourceMessageId } = convertedMessage(state, blocks);
    const comment = validateComments([{ id: randomUUID(), ...anchor, title: author,
      text: requireText(text, 9000), priority: "", movedFrom: { notebookId, messageId: sourceMessageId } }])[0];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.write(state);
      this.savePdfReview(hash, review.name, { ...review, comments: [...review.comments, comment] });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { comment, notebookId, hash };
  }

  undoPdfMessageConversion(hash, commentId) {
    const review = this.pdfReview(hash);
    const comment = review?.comments.find((item) => item.id === commentId);
    if (!comment?.movedFrom) throw new Error("这条批注不是从消息转来的。");
    if (comment.turns?.length) throw new Error("这条批注已有追问，请先处理追问再撤销。");
    const state = this.read(comment.movedFrom.notebookId);
    if (state.parent?.kind !== "pdf-chat" || state.parent.hash !== hash) throw new Error("来源会话已改变，不能撤销。");
    restoreConvertedMessage(state, comment.movedFrom.messageId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.write(state);
      this.savePdfReview(hash, review.name, { ...review, comments: review.comments.filter((item) => item.id !== commentId) });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { notebookId: state.id, hash, commentId };
  }

  saveModelSession(id, memberId, record) {
    const state = this.read(id);
    state.modelSessions ??= {};
    if (record) state.modelSessions[memberId] = record;
    else delete state.modelSessions[memberId];
    return this.write(state);
  }

  clearProfileModelSessions(profileId) {
    for (const { id } of this.db.prepare("SELECT id FROM notebook_documents").all()) {
      const state = this.read(id);
      let changed = false;
      for (const [key, record] of Object.entries(state.modelSessions || {})) {
        if (record.profileId !== profileId) continue;
        delete state.modelSessions[key];
        changed = true;
      }
      if (changed) this.write(state);
    }
  }

  // A chat's members start as a copy of the app's default roster the first time they are changed.
  changeMembers(id, action, settings, avatarFor) {
    const state = this.read(id);
    // The first edit gives the chat its own copy of the roster it was using.
    const roster = state.members?.length ? { members: state.members, defaultMember: state.defaultMember }
      : state.inherited ? structuredClone(state.inherited)
      : { members: structuredClone(settings.members || []), defaultMember: settings.defaultMember };
    const result = applyMemberChange(roster, action, settings.profiles, avatarFor);
    Object.assign(state, { members: roster.members, defaultMember: roster.defaultMember });
    // Choosing the default member by hand takes over from whoever was asked for last.
    if (action.type === "member-default") delete state.recentMember;
    return { state: this.write(state), result };
  }

  // Only the main process calls this, with a folder the user picked in the system dialog.
  setWorkDir(id, path) {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 1000) throw new Error("文件夹路径无效。");
    const state = this.read(id);
    state.workDir = path;
    return this.write(state);
  }

  // continueTurn: another group member answering the question that was just asked.
  // recentMember: the member the question asked for (with @); later questions go to them by default.
  saveReply(branchId, question, answer, source, attachments = [], id, tools = [], { continueTurn = false, recentMember } = {}) {
    const state = this.read(id);
    const turn = { id: randomUUID(), question, answer, source, ...(tools.length ? { tools } : {}) };
    if (attachments.length) turn.attachments = attachments;
    if (branchId) {
      find(state.branches, branchId).turns.push(turn);
    } else if (continueTurn) {
      appendReplyBlocks(state, turn);
    } else {
      appendMainTurn(state, turn);
    }
    if (typeof recentMember === "string" && recentMember) state.recentMember = recentMember;
    return this.write(state);
  }

  saveThreadReply(id, threadId, turn) {
    const state = this.read(id);
    findThread(state, threadId).turns.push(turn);
    return this.write(state);
  }

  saveNoteReply(id, noteId, turn) {
    const state = this.read(id);
    const note = find(state.notes, noteId);
    (note.turns ??= []).push(turn);
    return this.write(state);
  }

  write(state) {
    state.revision = (state.revision || 0) + 1;
    this.#absorb(state);
    this.update.run(this.#stored(state), Date.now(), state.id);
    return state;
  }

  close() {
    this.db.close();
  }
}
