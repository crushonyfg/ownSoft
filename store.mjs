import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { applyMemberChange } from "./members.mjs";
import { DatabaseSync } from "node:sqlite";
import { annotationOriginalKind, findAnchor, initialNotebook, messageGroups, sameMessage, splitReply } from "./notebook.mjs";
import { validateComments, validateTurns } from "./pdf-review.mjs";
import { mdTextLimit, reanchor } from "./md-document.mjs";
import { appendTurn, chatTurns, childKey, childKinds, syncTurns } from "./child-chats.mjs";
import { nextOccurrence, normalizeRepeat } from "./todos.mjs";
import { blockToNote, noteToBlock, putMessages, removeMessages, removeNote, restoreMessages, restoreNote,
  takeMessages } from "./structure.mjs";

// How many structural edits (moves, removals, conversions) can be undone.
const journalSize = 60;

// An annotation is a node of the chat tree like any chat: its own chat starts with the annotation's
// text as a note block (noteType "annotation"), followed by its follow-up conversation. So
// everything a chat can do (side questions, branches, annotations on it, highlights …) works on the
// annotation's text. The block is the text; the annotation in the margin shows it (see #fill).
export const annotationHead = "annotation";
const headOf = (chat) => chat?.blocks?.find((block) => block.noteType === annotationHead && !block.removed) ?? null;
const headSignature = (note) => JSON.stringify([note.text, (note.marks || []).map(({ start, quote, style }) => [start, quote, style])]);
function headBlock(note) {
  const id = randomUUID();
  return { id, kind: "paragraph", noteType: annotationHead, text: note.text || "", included: true,
    marks: (note.marks || []).map(({ start, quote, style }) => ({ blockId: id, start, quote, style })),
    ...(note.attachments?.length ? { attachments: note.attachments } : {}) };
}

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

function restoreLegacyConvertedMessage(state, note) {
  const kind = annotationOriginalKind(note);
  if (!kind) throw new Error("这条批注没有可恢复的来源消息。");
  const text = requireText(note.text, 160_000);
  const attachments = note.attachments?.length ? { attachments: note.attachments } : {};
  const candidates = state.blocks.filter((block) => block.kind === kind && block.removed && !block.text &&
    !block.conversionBackup && !state.notes.some((item) => item.sourceMessageId === block.id));
  if (candidates.length === 1) {
    const block = candidates[0];
    block.text = text;
    block.removed = false;
    block.marks = [];
    block.included = true;
    Object.assign(block, attachments);
    return;
  }
  // Older records do not identify their original block. When that blank slot is ambiguous, keep
  // every existing tombstone intact and restore a new message beside the passage it annotated.
  state.blocks.splice(insertionIndex(state, note.anchor.blockId), 0, {
    id: randomUUID(), kind, text, marks: [], included: true, ...attachments,
    ...(kind === "reply" ? { turnId: randomUUID(), ...(note.source ? { source: note.source } : {}) } : {})
  });
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
      if (!note.sourceMessageId && !annotationOriginalKind(note)) throw new Error("这条批注不是从消息转来的。");
      if (note.turns?.length) throw new Error("这条批注已有追问，请先处理追问再撤销。");
      if (note.sourceMessageId) restoreConvertedMessage(state, note.sourceMessageId);
      else restoreLegacyConvertedMessage(state, note);
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
      // Inside an annotation's own text: the same marks, kept on the annotation.
      if (action.noteId) {
        const note = find(state.notes, action.noteId);
        const quote = requireText(action.anchor?.quote);
        const start = action.anchor?.start;
        if (!Number.isInteger(start) || start < 0 || note.text.slice(start, start + quote.length) !== quote) {
          throw new Error("选区已改变，请重新选中文字。");
        }
        note.marks ??= [];
        const existing = note.marks.findIndex((mark) => mark.style === action.style && mark.start === start && mark.quote === quote);
        if (existing >= 0) note.marks.splice(existing, 1);
        else note.marks.push({ start, quote, style: action.style });
        break;
      }
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

// What each chat object was read with (row data by id), so writing it back only touches the rows
// that changed. Objects not read from rows (new chats, older documents) are written in full.
const readRows = new WeakMap();

export class NotebookStore {
  #rows;
  #docs;

  constructor(path) {
    this.db = new DatabaseSync(path);
    // An earlier draft kept these tables as an index only (keyed by block id alone). Every chat still
    // holds its messages in its document then, so they are dropped and refilled by moveToRows.
    const draft = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_blocks'").get();
    if (draft && !draft.sql.includes("PRIMARY KEY (chat_id, id)")) {
      this.db.exec(`DROP VIEW IF EXISTS relations; DROP TABLE IF EXISTS chat_blocks; DROP TABLE IF EXISTS chat_notes;
        DROP TABLE IF EXISTS attachment_uses; DROP TABLE IF EXISTS chat_links;`);
    }
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
      CREATE TABLE IF NOT EXISTS structure_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        label TEXT NOT NULL,
        chats TEXT NOT NULL,
        inverse TEXT NOT NULL
      );
      -- Every message block, annotation and attachment use as a row of its own (kept in step with
      -- the chat documents on every write): where it lives, in what order, which message it is part of.
      CREATE TABLE IF NOT EXISTS chat_blocks (
        chat_id TEXT NOT NULL,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        note_type TEXT,
        speaker TEXT,
        removed INTEGER NOT NULL,
        text TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (chat_id, id)
      );
      CREATE INDEX IF NOT EXISTS chat_blocks_chat ON chat_blocks(chat_id, position);
      CREATE INDEX IF NOT EXISTS chat_blocks_id ON chat_blocks(id);
      CREATE INDEX IF NOT EXISTS chat_blocks_message ON chat_blocks(chat_id, message_id);
      CREATE TABLE IF NOT EXISTS chat_notes (
        chat_id TEXT NOT NULL,
        id TEXT NOT NULL,
        block_id TEXT,
        removed INTEGER NOT NULL,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (chat_id, id)
      );
      CREATE INDEX IF NOT EXISTS chat_notes_block ON chat_notes(block_id);
      CREATE TABLE IF NOT EXISTS attachment_uses (
        attachment_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        name TEXT,
        extension TEXT,
        PRIMARY KEY (chat_id, owner_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS attachment_uses_attachment ON attachment_uses(attachment_id);
      -- Internal links written in messages and notes (ownsoft://chat|md|pdf/<id>).
      CREATE TABLE IF NOT EXISTS chat_links (
        chat_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        PRIMARY KEY (chat_id, block_id, target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS chat_links_target ON chat_links(target_id);
      -- Every relation in one place: what grew out of what, what hangs on what, what uses or links what.
      DROP VIEW IF EXISTS relations;
      CREATE VIEW relations AS
        SELECT 'chat' AS from_kind, parent_notebook AS from_id, kind AS relation, 'chat' AS to_kind, notebook_id AS to_id
          FROM child_chats WHERE parent_notebook IS NOT NULL
        UNION ALL SELECT 'chat', chat_id, 'contains', 'block', id FROM chat_blocks
        UNION ALL SELECT 'block', block_id, CASE removed WHEN 1 THEN 'removed-note' ELSE 'note' END, 'note', id FROM chat_notes
        UNION ALL SELECT owner_kind, owner_id, 'uses', 'attachment', attachment_id FROM attachment_uses
        UNION ALL SELECT 'block', block_id, 'links', target_kind, target_id FROM chat_links;
      -- To-dos (todos.mjs): from a message of a chat (block_id, quote) or typed in; due_at and repeat
      -- say when the AI works on it (ai = 1); its work goes into the to-do's chat ("todo:<id>").
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        block_id TEXT,
        quote TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        due_at INTEGER,
        repeat TEXT,
        member_id TEXT,
        ai INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open',
        runs INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS todos_due ON todos(status, ai, due_at);
      CREATE INDEX IF NOT EXISTS todos_chat ON todos(chat_id);
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
    // A chat is stored as rows: its messages in chat_blocks and its annotations in chat_notes (the
    // data column holds each one in full), the rest (title, members, branches …) as a small JSON
    // document in notebook_documents. Callers still hand over and get back a whole chat object.
    const update = this.db.prepare("UPDATE notebook_documents SET snapshot = ?, updated = ? WHERE id = ?");
    const insert = this.db.prepare("INSERT INTO notebook_documents VALUES (?, ?, ?)");
    this.#docs = { update, insert };
    this.update = { run: (json, at, id) => this.#atomically(() => {
      const state = { ...JSON.parse(json), id };
      update.run(this.#docJson(state), at, id);
      this.#saveRows(state);
    }) };
    this.insert = { run: (id, json, at) => this.#atomically(() => {
      const state = { ...JSON.parse(json), id };
      insert.run(id, this.#docJson(state), at);
      this.#saveRows(state);
    }) };
    this.#rows = {
      blocksOf: this.db.prepare("SELECT id, position, message_id, data FROM chat_blocks WHERE chat_id = ? ORDER BY position"),
      notesOf: this.db.prepare("SELECT id, removed, position, data FROM chat_notes WHERE chat_id = ? ORDER BY position"),
      clearBlocks: this.db.prepare("DELETE FROM chat_blocks WHERE chat_id = ?"),
      clearNotes: this.db.prepare("DELETE FROM chat_notes WHERE chat_id = ?"),
      clearUses: this.db.prepare("DELETE FROM attachment_uses WHERE chat_id = ?"),
      clearLinks: this.db.prepare("DELETE FROM chat_links WHERE chat_id = ?"),
      block: this.db.prepare(`INSERT OR REPLACE INTO chat_blocks (id, chat_id, position, message_id, kind, note_type, speaker,
        removed, text, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      dropBlock: this.db.prepare("DELETE FROM chat_blocks WHERE chat_id = ? AND id = ?"),
      note: this.db.prepare(`INSERT OR REPLACE INTO chat_notes (id, chat_id, block_id, removed, text, data, position)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      dropNote: this.db.prepare("DELETE FROM chat_notes WHERE chat_id = ? AND id = ?"),
      use: this.db.prepare(`INSERT OR REPLACE INTO attachment_uses (attachment_id, chat_id, owner_id, owner_kind, name, extension)
        VALUES (?, ?, ?, ?, ?, ?)`),
      dropUses: this.db.prepare("DELETE FROM attachment_uses WHERE chat_id = ? AND owner_id = ?"),
      link: this.db.prepare("INSERT OR IGNORE INTO chat_links (chat_id, block_id, target_kind, target_id) VALUES (?, ?, ?, ?)"),
      dropLinks: this.db.prepare("DELETE FROM chat_links WHERE chat_id = ? AND block_id = ?")
    };
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
    return this.#fill(this.#assemble(id, row.snapshot));
  }

  // A chat object from its document and rows. A document that still holds its messages (saved by
  // an earlier version, before moveToRows) is used as it is.
  #assemble(id, snapshot) {
    const state = JSON.parse(snapshot);
    state.id ??= id;
    if (Array.isArray(state.blocks)) return state;
    const known = { blocks: new Map(), notes: new Map() };
    state.blocks = this.#rows.blocksOf.all(state.id).map((row) => {
      known.blocks.set(row.id, { data: row.data, position: row.position, messageId: row.message_id });
      return JSON.parse(row.data);
    });
    state.notes = [];
    const removed = [];
    for (const row of this.#rows.notesOf.all(state.id)) {
      known.notes.set(row.id, { data: row.data, position: row.position, removed: row.removed });
      (row.removed ? removed : state.notes).push(JSON.parse(row.data));
    }
    if (removed.length) state.removedNotes = removed;
    readRows.set(state, known);
    return state;
  }

  // The document part of a chat: everything but its messages and annotations (and lists' turns,
  // which live in child chats).
  #docJson(state) {
    const { blocks, notes, removedNotes, inherited, ...rest } = state;
    return JSON.stringify({ ...rest, branches: withoutTurns(rest.branches) ?? rest.branches,
      ...(rest.threads ? { threads: withoutTurns(rest.threads) } : {}) });
  }

  // Writes a chat's messages and annotations as rows: only those that changed since the object was
  // read (or all of them for an object that was not read from rows). A list missing from the
  // object (e.g. a document-only update) is left as it is.
  #saveRows(state) {
    const rows = this.#rows;
    const known = readRows.get(state);
    const chat = state.id;
    const fresh = { blocks: new Map(), notes: new Map() };
    const dropOwner = (id) => { rows.dropUses.run(chat, id); rows.dropLinks.run(chat, id); };
    const use = (ref, ownerId, kind) => {
      if (ref?.id) rows.use.run(ref.id, chat, ownerId, kind, ref.name || null, ref.extension || null);
    };
    if (Array.isArray(state.blocks)) {
      if (!known) {
        rows.clearBlocks.run(chat);
        rows.clearLinks.run(chat);
        this.db.prepare("DELETE FROM attachment_uses WHERE chat_id = ? AND owner_kind = 'block'").run(chat);
      }
      let messageId = null;
      let previous = null;
      state.blocks.filter((block) => !block.virtual).forEach((block, position) => {
        if (!messageId || !sameMessage(previous, block)) messageId = block.id;
        previous = block;
        const data = JSON.stringify(block);
        fresh.blocks.set(block.id, { data, position, messageId });
        const before = known?.blocks.get(block.id);
        if (before && before.data === data && before.position === position && before.messageId === messageId) return;
        rows.block.run(block.id, chat, position, messageId, block.kind, block.noteType || null,
          block.source?.memberName || null, block.removed ? 1 : 0, block.text || "", data);
        if (before?.data === data) return;
        dropOwner(block.id);
        for (const ref of block.attachments || []) use(ref, block.id, "block");
        for (const [, kind, target] of String(block.text || "").matchAll(/ownsoft:\/\/(chat|md|pdf)\/([\w-]{1,80})/g)) {
          rows.link.run(chat, block.id, kind, target);
        }
      });
      for (const id of known?.blocks.keys() || []) {
        if (fresh.blocks.has(id)) continue;
        rows.dropBlock.run(chat, id);
        dropOwner(id);
      }
    }
    if (Array.isArray(state.notes)) {
      if (!known) {
        rows.clearNotes.run(chat);
        this.db.prepare("DELETE FROM attachment_uses WHERE chat_id = ? AND owner_kind = 'note'").run(chat);
      }
      const all = [...state.notes.map((note) => [note, 0]), ...(state.removedNotes || []).map((note) => [note, 1])];
      all.forEach(([note, removed], position) => {
        const { turns, ...kept } = note;
        const data = JSON.stringify(kept);
        fresh.notes.set(note.id, { data, position, removed });
        const before = known?.notes.get(note.id);
        if (before && before.data === data && before.position === position && before.removed === removed) return;
        rows.note.run(note.id, chat, note.anchor?.blockId || null, removed, note.text || "", data, position);
        if (before?.data === data) return;
        rows.dropUses.run(chat, note.id);
        for (const ref of note.attachments || []) use(ref, note.id, "note");
      });
      for (const id of known?.notes.keys() || []) {
        if (fresh.notes.has(id)) continue;
        rows.dropNote.run(chat, id);
        rows.dropUses.run(chat, id);
      }
    }
    // The object now matches the rows: a later write of it again only touches what changes next.
    if (Array.isArray(state.blocks) && Array.isArray(state.notes)) readRows.set(state, fresh);
  }

  // Chats saved by earlier versions keep their messages inside the document; this moves them into
  // rows (main.mjs makes a backup first).
  needsRowMove() {
    return Boolean(this.db.prepare("SELECT 1 FROM notebook_documents WHERE json_type(snapshot, '$.blocks') IS NOT NULL LIMIT 1").get());
  }

  moveToRows() {
    this.#atomically(() => {
      for (const { id, snapshot } of this.db.prepare("SELECT id, snapshot FROM notebook_documents WHERE json_type(snapshot, '$.blocks') IS NOT NULL").all()) {
        const state = { ...JSON.parse(snapshot), id };
        state.notes ??= [];
        this.#docs.update.run(this.#docJson(state), Date.now(), id);
        this.#saveRows(state);
      }
    });
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
    const children = new Map(this.db.prepare(`SELECT c.key, c.notebook_id, d.snapshot FROM child_chats c
      JOIN notebook_documents d ON d.id = c.notebook_id WHERE c.parent_notebook = ?`).all(state.id)
      .map(({ key, notebook_id: id, snapshot }) => [key, this.#assemble(id, snapshot)]));
    // Windows refresh a chat when its revision grows; a reply in one of its child chats counts.
    for (const child of children.values()) state.revision = (state.revision || 0) + (child.revision || 0);
    const signatures = new Map();
    for (const [item, key, parent] of this.#conversations(state)) {
      const child = children.get(key);
      if (child) item.turns = chatTurns(child);
      else if (parent.kind !== "note") item.turns ??= [];
      signatures.set(key, !child && item.turns?.length ? "inline" : JSON.stringify(item.turns ?? []));
      const head = parent.kind === "note" ? headOf(child) : null;
      if (head) {
        item.text = head.text;
        item.marks = (head.marks || []).map(({ start, quote, style }) => ({ start, quote, style }));
        signatures.set(`${key}#head`, headSignature(item));
      }
    }
    filledLists.set(state, signatures);
    this.#sourceMessage(state);
    // A chat without members of its own talks with those of the chat it grew from (for a review's
    // chats: the chat the review was last opened from). Not stored; see #stored.
    const inherited = state.members?.length ? null : this.#inheritedRoster(state);
    if (inherited) state.inherited = inherited;
    else delete state.inherited;
    return state;
  }

  // An annotation's chat begins with the message the annotation hangs on (context), then the
  // annotation's text, then its follow-ups. That first message is the parent chat's own message,
  // read from there each time (never stored here): a block marked virtual, with the annotated
  // passage marked. Its id is fixed, so things anchored on it stay put.
  #sourceMessage(state) {
    if (!["note", "branch", "todo"].includes(state.parent?.kind) || !Array.isArray(state.blocks)) return;
    state.blocks = state.blocks.filter((block) => !block.virtual);
    // A side question's chat (a branch) begins the same way: the message it was asked about.
    const { notebookId, noteId, branchId, todoId } = state.parent;
    let anchor = null;
    if (state.parent.kind === "todo") {
      const todo = this.db.prepare("SELECT block_id, quote FROM todos WHERE id = ?").get(todoId);
      anchor = todo?.block_id ? { blockId: todo.block_id, quote: todo.quote || "", start: 0 } : null;
    } else if (state.parent.kind === "note") {
      const row = this.db.prepare("SELECT data FROM chat_notes WHERE chat_id = ? AND id = ?").get(notebookId, noteId);
      anchor = row ? JSON.parse(row.data).anchor : null;
    } else {
      const row = this.db.prepare("SELECT json_extract(snapshot, '$.branches') AS branches FROM notebook_documents WHERE id = ?").get(notebookId);
      anchor = (row?.branches ? JSON.parse(row.branches) : []).find((item) => item.id === branchId)?.anchor ?? null;
    }
    const at = anchor && this.db.prepare("SELECT message_id FROM chat_blocks WHERE chat_id = ? AND id = ?").get(notebookId, anchor.blockId);
    if (!at) return;
    const parts = this.db.prepare(`SELECT data FROM chat_blocks WHERE chat_id = ? AND message_id = ? AND removed = 0
      ORDER BY position`).all(notebookId, at.message_id).map((item) => JSON.parse(item.data));
    if (!parts.length) return;
    const text = parts.map((block) => block.text).join("\n\n");
    const id = `source-${noteId || branchId || todoId}`;
    const start = anchor.quote ? findAnchor(text, anchor) : null;
    const title = this.db.prepare("SELECT json_extract(snapshot, '$.title') AS title FROM notebook_documents WHERE id = ?").get(notebookId)?.title;
    state.blocks.unshift({ id, kind: "paragraph", noteType: "source", virtual: true, included: false, text,
      marks: start === null ? [] : [{ blockId: id, start, quote: anchor.quote, style: "note" }],
      ...(parts.some((block) => block.attachments?.length) ? { attachments: parts.flatMap((block) => block.attachments || []) } : {}),
      source: { chatId: notebookId, messageId: at.message_id, kind: parts[0].kind, speaker: parts[0].source?.memberName || null, noteType: parts[0].noteType || null,
        chatTitle: title || "" } });
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
      const headKey = `${key}#head`;
      if (parent.kind === "note" && signatures.has(headKey) && signatures.get(headKey) !== headSignature(item)) {
        const chat = this.childChat(key);
        const head = headOf(chat);
        if (head) {
          head.text = item.text;
          head.marks = (item.marks || []).map(({ start, quote, style }) => ({ blockId: head.id, start, quote, style }));
          this.write(chat);
        }
        signatures.set(headKey, headSignature(item));
      }
      if (!Array.isArray(item.turns)) continue;
      const signature = JSON.stringify(item.turns);
      if (signatures.get(key) === signature) continue;
      this.syncChildTurns(key, parent, item.turns, { prune: true, head: parent.kind === "note" ? item : null });
      signatures.set(key, signature);
    }
    filledLists.set(state, signatures);
    // An annotation turned into a note block, or deleted, keeps its follow-up chat while it can
    // still be turned back (see structure.mjs).
    for (const block of state.blocks || []) if (block.fromNote) kept.add(childKey.note(state.id, block.fromNote.id));
    for (const note of state.removedNotes || []) kept.add(childKey.note(state.id, note.id));
    for (const { id } of this.db.prepare("SELECT id FROM todos WHERE chat_id = ?").all(state.id)) kept.add(childKey.todo(id));
    for (const { key } of this.db.prepare("SELECT key FROM child_chats WHERE parent_notebook = ?").all(state.id)) {
      if (!kept.has(key)) this.deleteChildChat(key);
    }
  }

  #insertChat(state) {
    this.#atomically(() => {
      this.#docs.insert.run(state.id, this.#docJson(state), Date.now());
      this.#saveRows(state);
      this.#absorb(state);
    });
  }

  childChat(key) {
    const row = this.db.prepare("SELECT notebook_id FROM child_chats WHERE key = ?").get(key);
    if (!row) return null;
    const found = this.select.get(row.notebook_id);
    if (!found) {
      this.db.prepare("DELETE FROM child_chats WHERE key = ?").run(key);
      return null;
    }
    return this.#fill(this.#assemble(row.notebook_id, found.snapshot));
  }

  // parent: { kind, title, notebookId?, … } — where the conversation grew from.
  // note: for an annotation's chat, the annotation (its text becomes the first block); found from
  // the parent chat's rows when not given.
  ensureChildChat(key, parent, note = null) {
    const existing = this.childChat(key);
    if (existing) return existing;
    if (!childKinds[parent?.kind]) throw new Error("对话来源无效。");
    if (parent.kind === "note" && !note) {
      const row = this.db.prepare("SELECT data FROM chat_notes WHERE chat_id = ? AND id = ?").get(parent.notebookId, parent.noteId);
      note = row ? JSON.parse(row.data) : null;
    }
    const state = { id: randomUUID(), title: requireText(parent.title || childKinds[parent.kind], 160).trim(),
      blocks: note ? [headBlock(note)] : [], notes: [], branches: [], parent: { ...parent, key } };
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
    if (kind === "todo") {
      const todo = this.todo(itemId);
      return this.ensureChildChat(childKey.todo(todo.id), { kind: "todo", notebookId: todo.chatId || undefined, todoId: todo.id,
        title: `待办 · ${label(todo.text, 40)}` }).id;
    }
    if (kind === "note" || kind === "branch" || kind === "thread") {
      const found = this.#conversations(this.read(notebookId)).find(([item, , parent]) => parent.kind === kind && item.id === itemId);
      if (!found) throw new Error("这段对话已不存在。");
      const chat = this.ensureChildChat(found[1], found[2], kind === "note" ? found[0] : null);
      // Annotation chats made before the annotation's text was their first block get it now.
      if (kind === "note" && !headOf(chat)) {
        chat.blocks.unshift(headBlock(found[0]));
        this.write(chat);
      }
      return chat.id;
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

  syncChildTurns(key, parent, turns, { prune = false, head = null } = {}) {
    let chat = this.childChat(key);
    if (!chat && !turns?.length) return null;
    chat ??= this.ensureChildChat(key, parent, head);
    if (syncTurns(chat, turns || [], { prune })) this.write(chat);
    return chat;
  }

  appendChildTurn(key, parent, turn) {
    const chat = this.ensureChildChat(key, parent);
    appendTurn(chat, turn);
    return this.write(chat);
  }

  // ---- to-dos (todos.mjs) ------------------------------------------------------------------------
  #todoRow(row) {
    return row && { id: row.id, chatId: row.chat_id, blockId: row.block_id, quote: row.quote, text: row.text, dueAt: row.due_at,
      repeat: row.repeat ? JSON.parse(row.repeat) : null, memberId: row.member_id, ai: Boolean(row.ai), status: row.status,
      runs: row.runs, lastRunAt: row.last_run_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
      chatTitle: row.chat_id ? this.db.prepare("SELECT json_extract(snapshot, '$.title') AS title FROM notebook_documents WHERE id = ?")
        .get(row.chat_id)?.title || "" : "" };
  }

  todo(id) {
    const todo = this.#todoRow(this.db.prepare("SELECT * FROM todos WHERE id = ?").get(String(id || "")));
    if (!todo) throw new Error("这条待办已不存在。");
    return todo;
  }

  todos() {
    return this.db.prepare("SELECT * FROM todos ORDER BY (due_at IS NULL), due_at, created_at").all().map((row) => this.#todoRow(row));
  }

  // fields: { text, chatId?, blockId?, quote?, dueAt?, repeat?, memberId?, ai? } (all but text optional when updating).
  saveTodo(fields, id = null) {
    const before = id ? this.todo(id) : null;
    const text = requireText(fields.text ?? before?.text, 20_000).trim();
    if (!text) throw new Error("请写下要做的事。");
    const dueAt = fields.dueAt === undefined ? before?.dueAt ?? null
      : fields.dueAt === null || fields.dueAt === "" ? null : Number(fields.dueAt);
    if (dueAt !== null && !Number.isFinite(dueAt)) throw new Error("日期无效。");
    const repeat = fields.repeat === undefined ? before?.repeat ?? null : normalizeRepeat(fields.repeat);
    if (repeat && dueAt === null) throw new Error("重复的待办需要一个开始日期。");
    const chatId = before ? before.chatId : typeof fields.chatId === "string" && this.select.get(fields.chatId) ? fields.chatId : null;
    const blockId = before ? before.blockId : chatId && typeof fields.blockId === "string" ? fields.blockId.slice(0, 80) : null;
    const quote = before ? before.quote : String(fields.quote || "").slice(0, 4000);
    const memberId = fields.memberId === undefined ? before?.memberId ?? null : fields.memberId ? String(fields.memberId).slice(0, 80) : null;
    const ai = fields.ai === undefined ? before?.ai ?? true : Boolean(fields.ai);
    const now = Date.now();
    if (before) {
      // A new date (or reopening) puts it back on the list of things to do.
      const status = fields.status && ["open", "ran", "done"].includes(fields.status) ? fields.status
        : dueAt !== before.dueAt && before.status === "ran" ? "open" : before.status;
      this.db.prepare(`UPDATE todos SET text = ?, due_at = ?, repeat = ?, member_id = ?, ai = ?, status = ?, updated_at = ?
        WHERE id = ?`).run(text, dueAt, repeat ? JSON.stringify(repeat) : null, memberId, ai ? 1 : 0, status, now, id);
      return this.todo(id);
    }
    const created = randomUUID();
    this.db.prepare(`INSERT INTO todos (id, chat_id, block_id, quote, text, due_at, repeat, member_id, ai, status, runs,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`)
      .run(created, chatId, blockId, quote, text, dueAt, repeat ? JSON.stringify(repeat) : null, memberId, ai ? 1 : 0, now, now);
    return this.todo(created);
  }

  deleteTodo(id) {
    const todo = this.todo(id);
    this.db.prepare("DELETE FROM todos WHERE id = ?").run(todo.id);
    this.deleteChildChat(childKey.todo(todo.id));
  }

  // When the next of the AI's to-dos comes due (null: none waiting).
  nextTodoDue() {
    return this.db.prepare("SELECT MIN(due_at) AS at FROM todos WHERE status = 'open' AND ai = 1 AND due_at IS NOT NULL").get()?.at ?? null;
  }

  // The AI's to-dos whose time has come.
  dueTodos(now = Date.now()) {
    return this.db.prepare("SELECT * FROM todos WHERE status = 'open' AND ai = 1 AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at")
      .all(now).map((row) => this.#todoRow(row));
  }

  // After the AI worked on it: a repeating to-do moves to its next time; a one-off waits for the
  // user to look at the result. A failed run stays due (it is tried again next time the app checks)
  // unless it repeats.
  // dueAtStart: its time when the run began; if the AI gave it a later time meanwhile, that stands.
  finishTodoRun(id, { ok, error = "", dueAtStart } = {}, now = Date.now()) {
    const todo = this.todo(id);
    if (ok && dueAtStart !== undefined && todo.dueAt !== dueAtStart && todo.dueAt > now) {
      this.db.prepare("UPDATE todos SET status = 'open', runs = runs + 1, last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      return this.todo(id);
    }
    const next = todo.repeat ? nextOccurrence(todo.dueAt, todo.repeat, now) : null;
    const status = todo.repeat ? "open" : ok ? "ran" : "open";
    const dueAt = todo.repeat ? next : ok ? todo.dueAt : now + 30 * 60_000;
    this.db.prepare("UPDATE todos SET status = ?, due_at = ?, runs = runs + ?, last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(status, dueAt, ok ? 1 : 0, now, ok ? null : String(error).slice(0, 2000), now, id);
    return this.todo(id);
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
    const todos = this.db.prepare("SELECT * FROM todos WHERE chat_id = ? ORDER BY created_at").all(state.id)
      .map((row) => this.#todoRow(row)).map((todo) => this.#chatNode(childKey.todo(todo.id), {
        kind: "todo", title: label(todo.text, 60), quote: label(todo.quote, 120),
        text: todo.dueAt ? `${new Date(todo.dueAt).toLocaleString("zh-CN", { hour12: false })}` : "", turns: 0,
        open: { kind: "todo", itemId: todo.id } }, level, depth, seen));
    for (const node of todos) node.turns = node.chatId ? chatTurns(this.read(node.chatId)).length : 0;
    return [...nodes, ...pdfs.values(), ...todos];
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
    if (itself) {
      this.db.prepare("DELETE FROM notebook_documents WHERE id = ?").run(notebookId);
      this.#unindexChat(notebookId);
    }
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
    return this.db.prepare("SELECT id, snapshot FROM notebook_documents").all().map(({ id, snapshot }) => this.#assemble(id, snapshot));
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
      this.#unindexChat(id);
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
    // A deleted annotation is kept aside so the deletion can be undone.
    if (action?.type === "delete-note") {
      return this.structure({ type: "remove-note", chat: id ?? this.activeId(), noteId: action.id }).state;
    }
    const state = applyChange(this.read(id), action);
    const saved = this.write(state);
    if (action?.type === "message-to-annotation") {
      this.#journal("消息转为批注", [saved.id], { type: "undo-annotation", chat: saved.id, noteId: saved.notes.at(-1).id });
    }
    return saved;
  }

  // ---- structural edits (structure.mjs), each one undoable --------------------------------------
  // op: { type: "move", from, ids, to, before }: whole messages (with their annotations, branches
  //       and their follow-up chats) go before the message `before` (null: the end) of chat `to`
  //     { type: "remove", chat, ids } / { type: "restore", chat, blocks }
  //     { type: "note-to-block", chat, noteId, before? } / { type: "block-to-note", chat, blockId }
  //     { type: "remove-note", chat, noteId } / { type: "restore-note", chat, noteId }
  //     { type: "undo-annotation", chat, noteId }: a message turned into an annotation goes back
  // Returns { label, chats (ids touched), state (of the chat it started in), focus? }.
  structure(op, { journal = true } = {}) {
    const result = this.#structure(op);
    if (journal && result.inverse) this.#journal(result.label, result.chats, result.inverse);
    return result;
  }

  undoStructure() {
    const row = this.db.prepare("SELECT seq, label, inverse FROM structure_log ORDER BY seq DESC LIMIT 1").get();
    if (!row) throw new Error("没有可以撤销的操作。");
    this.db.prepare("DELETE FROM structure_log WHERE seq = ?").run(row.seq);
    try {
      return { ...this.#structure(JSON.parse(row.inverse)), label: row.label };
    } catch (error) {
      throw new Error(`无法撤销「${row.label}」：${error.message}`);
    }
  }

  structureLog(limit = 20) {
    return this.db.prepare("SELECT seq, at, label, chats FROM structure_log ORDER BY seq DESC LIMIT ?").all(limit)
      .map((row) => ({ ...row, chats: JSON.parse(row.chats) }));
  }

  #journal(text, chats, inverse) {
    this.db.prepare("INSERT INTO structure_log (at, label, chats, inverse) VALUES (?, ?, ?, ?)")
      .run(Date.now(), text, JSON.stringify(chats), JSON.stringify(inverse));
    this.db.prepare("DELETE FROM structure_log WHERE seq <= (SELECT MAX(seq) FROM structure_log) - ?").run(journalSize);
  }

  // The chat a block lives in now (it may have been moved since an operation named another). A chat
  // made from selected messages keeps their ids, so an id can be in several chats: the hinted chat
  // first, else the most recently changed one.
  chatOfBlock(blockId, hint) {
    if (typeof blockId !== "string" || !/^[\w-]{1,80}$/.test(blockId)) throw new Error("消息 ID 无效。");
    if (hint && this.db.prepare("SELECT 1 FROM chat_blocks WHERE chat_id = ? AND id = ?").get(hint, blockId)) return hint;
    const row = this.db.prepare(`SELECT b.chat_id FROM chat_blocks b JOIN notebook_documents d ON d.id = b.chat_id
      WHERE b.id = ? ORDER BY d.updated DESC LIMIT 1`).get(blockId);
    if (!row) throw new Error("找不到这条消息，可能已被删除。");
    return row.chat_id;
  }

  // A message by any of its block ids: its chat, first block and blocks, from the rows.
  findMessage(blockId, hint) {
    const chatId = this.chatOfBlock(blockId, hint);
    const { message_id: messageId } = this.db.prepare("SELECT message_id FROM chat_blocks WHERE chat_id = ? AND id = ?")
      .get(chatId, blockId);
    const blocks = this.db.prepare(`SELECT id, kind, note_type, speaker, removed, text, position FROM chat_blocks
      WHERE chat_id = ? AND message_id = ? ORDER BY position`).all(chatId, messageId);
    // The message that follows (to put something after this one), or null at the end.
    const next = this.db.prepare("SELECT message_id FROM chat_blocks WHERE chat_id = ? AND position > ? AND message_id <> ? ORDER BY position LIMIT 1")
      .get(chatId, blocks.at(-1).position, messageId)?.message_id ?? null;
    return { chatId, messageId, blocks, next };
  }

  // Messages whose text contains a phrase, newest chats first (for the command line).
  searchMessages(text, limit = 20) {
    const phrase = String(text || "").trim();
    if (!phrase) return [];
    return this.db.prepare(`SELECT b.message_id AS messageId, b.chat_id AS chatId, b.kind, substr(b.text, 1, 120) AS preview,
        json_extract(d.snapshot, '$.title') AS title
      FROM chat_blocks b JOIN notebook_documents d ON d.id = b.chat_id
      WHERE b.removed = 0 AND instr(b.text, ?) > 0 ORDER BY d.updated DESC, b.position LIMIT ?`).all(phrase, limit);
  }

  // Which chats and annotations use an attachment (for file cleanup and "where is this file").
  attachmentUses(attachmentId) {
    return this.db.prepare("SELECT chat_id AS chatId, owner_id AS ownerId, owner_kind AS ownerKind FROM attachment_uses WHERE attachment_id = ?")
      .all(attachmentId);
  }

  #atomically(task) {
    if (this.db.isTransaction) return task();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = task();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Everything related to a chat, block, note or attachment, in both directions (relations view).
  relationsOf(id) {
    return this.db.prepare("SELECT from_kind AS fromKind, from_id AS fromId, relation, to_kind AS toKind, to_id AS toId " +
      "FROM relations WHERE from_id = ? OR to_id = ? LIMIT 500").all(id, id);
  }

  #unindexChat(id) {
    this.#rows.clearLinks.run(id);
    this.#rows.clearBlocks.run(id);
    this.#rows.clearNotes.run(id);
    this.#rows.clearUses.run(id);
  }

  #saveAll(states) {
    this.#atomically(() => { for (const state of states) this.write(state); });
  }

  // A follow-up chat (or branch chat) whose annotation moved to another chat goes with it.
  #rekeyChild(oldKey, newKey, notebookId) {
    const row = this.db.prepare("SELECT notebook_id FROM child_chats WHERE key = ?").get(oldKey);
    if (!row || oldKey === newKey) return;
    this.db.prepare("UPDATE child_chats SET key = ?, parent_notebook = ? WHERE key = ?").run(newKey, notebookId, oldKey);
    const doc = this.select.get(row.notebook_id);
    if (!doc) return;
    const chat = JSON.parse(doc.snapshot);
    chat.parent = { ...chat.parent, key: newKey, notebookId };
    this.update.run(JSON.stringify(chat), Date.now(), row.notebook_id);
  }

  #structure(op) {
    switch (op?.type) {
      case "move": {
        const ids = Array.isArray(op.ids) ? op.ids.filter((id) => typeof id === "string") : [];
        if (!ids.length) throw new Error("请选择要移动的消息。");
        const fromId = this.chatOfBlock(ids[0], op.from);
        const toId = typeof op.to === "string" && op.to ? op.to : fromId;
        const source = this.read(fromId);
        const target = toId === fromId ? source : this.read(toId);
        const taken = takeMessages(source, ids);
        if (taken.blocks.some((block) => block.id === op.before)) throw new Error("不能放到它自己的位置上。");
        const before = typeof op.before === "string" ? op.before : null;
        if (toId !== fromId) {
          for (const note of taken.notes) this.#rekeyChild(childKey.note(fromId, note.id), childKey.note(toId, note.id), toId);
          for (const branch of taken.branches) {
            this.#rekeyChild(childKey.branch(fromId, branch.id), childKey.branch(toId, branch.id), toId);
          }
          for (const block of taken.blocks.filter((item) => item.fromNote)) {
            this.#rekeyChild(childKey.note(fromId, block.fromNote.id), childKey.note(toId, block.fromNote.id), toId);
          }
        }
        putMessages(target, taken, before);
        this.#saveAll(toId === fromId ? [source] : [target, source]);
        const count = taken.starts.length;
        return { label: toId === fromId ? `移动 ${count} 条消息` : `把 ${count} 条消息移到「${label(target.title, 24)}」`,
          chats: [...new Set([fromId, toId])], state: source, focus: { chat: toId, messageId: taken.starts[0] },
          inverse: { type: "move", from: toId, ids: taken.starts, to: fromId, before: taken.next } };
      }
      case "remove": {
        const chatId = this.chatOfBlock(op.ids?.[0], op.chat);
        const state = this.read(chatId);
        const backup = removeMessages(state, op.ids);
        this.#saveAll([state]);
        return { label: "移除消息", chats: [chatId], state, inverse: { type: "restore", chat: chatId, blocks: backup } };
      }
      case "restore": {
        const blocks = Array.isArray(op.blocks) ? op.blocks : [];
        const chatId = this.chatOfBlock(blocks[0]?.id, op.chat);
        const state = this.read(chatId);
        restoreMessages(state, blocks);
        this.#saveAll([state]);
        return { label: "恢复消息", chats: [chatId], state, focus: { chat: chatId, messageId: blocks[0].id },
          inverse: { type: "remove", chat: chatId, ids: blocks.map((block) => block.id) } };
      }
      case "note-to-block": {
        const state = this.read(op.chat);
        const block = noteToBlock(state, op.noteId, typeof op.before === "string" || op.before === null ? op.before : undefined);
        this.#saveAll([state]);
        return { label: "批注转为笔记块", chats: [state.id], state, focus: { chat: state.id, messageId: block.id },
          inverse: { type: "block-to-note", chat: state.id, blockId: block.id } };
      }
      case "block-to-note": {
        const chatId = this.chatOfBlock(op.blockId, op.chat);
        const state = this.read(chatId);
        const note = blockToNote(state, op.blockId);
        this.#saveAll([state]);
        return { label: "笔记块转回批注", chats: [chatId], state, focus: { chat: chatId, noteId: note.id },
          inverse: { type: "note-to-block", chat: chatId, noteId: note.id } };
      }
      case "remove-note": {
        const state = this.read(op.chat);
        removeNote(state, op.noteId);
        this.#saveAll([state]);
        return { label: "删除批注", chats: [state.id], state,
          inverse: { type: "restore-note", chat: state.id, noteId: op.noteId } };
      }
      case "restore-note": {
        const state = this.read(op.chat);
        restoreNote(state, op.noteId);
        this.#saveAll([state]);
        return { label: "恢复批注", chats: [state.id], state, focus: { chat: state.id, noteId: op.noteId },
          inverse: { type: "remove-note", chat: state.id, noteId: op.noteId } };
      }
      // An image note's picture: the edited one (shapes drawn over the original, flattened into a new
      // file `ref`, so models see the marks), or back to the original (restore). The original and the
      // shapes are kept on the block to edit again.
      case "edit-image": {
        const chatId = this.chatOfBlock(op.blockId, op.chat);
        const state = this.read(chatId);
        const block = find(state.blocks, op.blockId);
        if (block.noteType !== "image" || !block.attachments?.[0]) throw new Error("这不是图片笔记。");
        const before = { ref: block.attachments[0], edit: block.imageEdit || null };
        const original = block.imageEdit?.original || block.attachments[0];
        let ref = op.ref;
        let edit = null;
        if (op.restore) {
          if (!block.imageEdit) throw new Error("这张图还没有编辑过。");
          ref = original;
        } else if (op.edit === null) {
          edit = null;
        } else {
          const shapes = Array.isArray(op.edit?.shapes) ? op.edit.shapes : [];
          if (shapes.length > 2000 || JSON.stringify(shapes).length > 1_000_000) throw new Error("图上的标注太多了。");
          edit = { original: op.edit?.original || original, shapes,
            width: Number(op.edit?.width) || 0, height: Number(op.edit?.height) || 0 };
        }
        if (!ref?.id || !/^\.(png|jpe?g|webp)$/.test(ref.extension || "")) throw new Error("图片文件无效。");
        block.attachments = [ref];
        if (edit) block.imageEdit = edit;
        else delete block.imageEdit;
        this.#saveAll([state]);
        return { label: op.restore ? "恢复原图" : op.edit === null ? "撤销图片编辑" : "编辑图片", chats: [chatId], state,
          focus: { chat: chatId, messageId: block.id },
          inverse: { type: "edit-image", chat: chatId, blockId: block.id, ref: before.ref, edit: before.edit } };
      }
      case "undo-annotation": {
        const state = this.undoChatAnnotation(op.chat, op.noteId);
        return { label: "撤销转批注", chats: [op.chat], state };
      }
      default:
        throw new Error("未知的结构操作。");
    }
  }

  annotationTargets() {
    const rows = this.db.prepare("SELECT id, snapshot, updated FROM notebook_documents ORDER BY updated DESC").all();
    const chats = rows.map(({ id, snapshot, updated }) => {
      const { title, parent } = JSON.parse(snapshot);
      return { id, title, parent, updated };
    });
    const pdfChats = new Map(chats.filter((chat) => chat.parent?.kind === "pdf-chat")
      .map((chat) => [chat.parent.hash, chat.id]));
    const mdChats = new Map(chats.filter((chat) => chat.parent?.kind === "md-chat")
      .map((chat) => [chat.parent.mdId, chat.id]));
    const ids = new Set(chats.map((chat) => chat.id));
    return chats.map(({ id, title, parent, updated }) => {
      const parentId = parent?.notebookId || (parent?.kind === "pdf-comment" ? pdfChats.get(parent.hash) : null) ||
        (parent?.kind === "md-comment" ? mdChats.get(parent.mdId) : null) || parent?.rosterNotebookId || null;
      return { id, title, kind: parent?.kind || "chat", parentId: parentId !== id && ids.has(parentId) ? parentId : null, updated };
    });
  }

  annotationMessages(notebookId) {
    const state = this.read(notebookId);
    return messageGroups(state.blocks).flatMap((group) => {
      const live = group.blocks.filter((block) => !block.removed && block.text?.trim());
      return live.length ? [{ id: group.blocks[0].id, kind: group.kind,
        ...(live[0].noteType ? { noteType: live[0].noteType } : {}),
        preview: live.map((block) => block.text).join(" ").replace(/\s+/g, " ").slice(0, 180) }] : [];
    });
  }

  annotationMessage(notebookId, messageId) {
    const state = this.read(notebookId);
    const group = messageGroups(state.blocks).find((item) => item.blocks.some((block) => block.id === messageId));
    if (!group) throw new Error("找不到这个消息 ID。");
    const blocks = group.blocks.filter((block) => !block.removed && block.text?.trim())
      .map(({ id, text, noteType }) => ({ id, text, ...(noteType ? { noteType } : {}) }));
    if (!blocks.length) throw new Error("这条消息已移除，不能作为批注锚点。");
    return { notebookId, messageId: group.blocks[0].id, kind: group.kind, blocks };
  }

  resolveAnnotationMessage(messageId) {
    if (typeof messageId !== "string" || messageId.length < 1 || messageId.length > 80) throw new Error("消息 ID 无效。");
    for (const { id } of this.db.prepare("SELECT id FROM notebook_documents ORDER BY updated DESC").all()) {
      const state = this.read(id);
      if (!state.blocks.some((block) => block.id === messageId)) continue;
      return { title: state.title, ...this.annotationMessage(id, messageId) };
    }
    throw new Error("找不到这个消息 ID。");
  }

  moveMessageToChatAnnotation(sourceId, ids, targetId, anchor) {
    if (sourceId === targetId) {
      const state = this.change({ type: "message-to-annotation", ids, anchor }, sourceId);
      return { sourceId, targetId, noteId: state.notes.at(-1).id };
    }
    const source = this.read(sourceId);
    const target = this.read(targetId);
    const checked = checkedAnchor(target, anchor);
    const blocks = messageBlocks(source, ids);
    const { text, author, attachments, speaker, sourceMessageId } = convertedMessage(source, blocks);
    const note = { id: randomUUID(), anchor: checked, text: requireText(text, 160_000), author,
      pinned: false, sourceNotebookId: sourceId, sourceMessageId,
      ...(attachments.length ? { attachments } : {}), ...(speaker ? { source: speaker } : {}) };
    target.notes.push(note);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.write(source);
      this.write(target);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.#journal(`消息转为「${label(target.title, 24)}」里的批注`, [sourceId, targetId],
      { type: "undo-annotation", chat: targetId, noteId: note.id });
    return { sourceId, targetId, noteId: note.id };
  }

  undoChatAnnotation(targetId, noteId) {
    const target = this.read(targetId);
    const note = find(target.notes, noteId);
    const sourceId = note.sourceNotebookId || targetId;
    if (sourceId === targetId) return this.change({ type: "undo-message-to-annotation", id: noteId }, targetId);
    if (!note.sourceMessageId) throw new Error("原消息已无法撤销。");
    if (note.turns?.length) throw new Error("这条批注已有追问，请先处理追问再撤销。");
    const source = this.read(sourceId);
    restoreConvertedMessage(source, note.sourceMessageId);
    target.notes = target.notes.filter((item) => item.id !== noteId);
    if (target.context?.notes) target.context.notes = target.context.notes.filter((id) => id !== noteId);
    target.mainMemoryIds = (target.mainMemoryIds || []).filter((id) => id !== noteId);
    for (const branch of target.branches) branch.memoryIds = branch.memoryIds.filter((id) => id !== noteId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.write(source);
      this.write(target);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return target;
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
      this.savePdfReview(hash, review.name, { ...review, comments: [...review.comments, comment], chat: [] });
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
      this.savePdfReview(hash, review.name, { ...review, comments: review.comments.filter((item) => item.id !== commentId), chat: [] });
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

  // Saves a chat object: its document, and the message and annotation rows that changed.
  write(state) {
    state.revision = (state.revision || 0) + 1;
    this.#atomically(() => {
      this.#absorb(state);
      this.#docs.update.run(this.#docJson(state), Date.now(), state.id);
      this.#saveRows(state);
    });
    return state;
  }

  close() {
    this.db.close();
  }
}
