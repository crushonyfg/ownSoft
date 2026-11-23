// Structural edits of chats: where messages, note blocks and margin annotations live. These are pure
// functions on chat states; the store persists them, carries along the child chats (follow-ups,
// branches) of what moved, and keeps a journal so recent structural edits can be undone.
import { randomUUID } from "node:crypto";
import { messageGroups } from "./notebook.mjs";

const cloned = (value) => structuredClone(value);
const stripTurns = ({ turns, ...rest }) => rest;

// The whole messages containing these block ids, in document order (a reply's paragraphs together).
export function messagesOf(state, ids) {
  const wanted = new Set(ids);
  const groups = messageGroups(state.blocks).filter((group) => group.blocks.some((block) => wanted.has(block.id)));
  if (!groups.length) throw new Error("找不到要移动的消息，可能已被移走或删除。");
  return groups;
}

// Index where a message starting at (or containing) beforeId begins; null or unknown → the end.
function startIndex(state, beforeId) {
  if (!beforeId) return state.blocks.length;
  const group = messageGroups(state.blocks).find((item) => item.blocks.some((block) => block.id === beforeId));
  return group ? state.blocks.indexOf(group.blocks[0]) : state.blocks.length;
}

// Index just after the message containing blockId (or the end).
function afterIndex(state, blockId) {
  const group = messageGroups(state.blocks).find((item) => item.blocks.some((block) => block.id === blockId));
  return group ? state.blocks.indexOf(group.blocks.at(-1)) + 1 : state.blocks.length;
}

function forgetNote(state, noteId) {
  if (state.context?.notes) state.context.notes = state.context.notes.filter((id) => id !== noteId);
  state.mainMemoryIds = (state.mainMemoryIds || []).filter((id) => id !== noteId);
  for (const branch of state.branches || []) branch.memoryIds = (branch.memoryIds || []).filter((id) => id !== noteId);
}

// Takes whole messages out of a chat, with the annotations and branches anchored on them.
// next: the message that followed them (where they go back to on undo), or null at the end.
export function takeMessages(state, ids) {
  const groups = messagesOf(state, ids);
  const blocks = groups.flatMap((group) => group.blocks);
  const moving = new Set(blocks.map((block) => block.id));
  const lastIndex = state.blocks.indexOf(blocks.at(-1));
  const next = state.blocks.slice(lastIndex + 1).find((block) => !moving.has(block.id))?.id ?? null;
  state.blocks = state.blocks.filter((block) => !moving.has(block.id));
  const notes = (state.notes || []).filter((note) => moving.has(note.anchor?.blockId));
  const branches = (state.branches || []).filter((branch) => moving.has(branch.anchor?.blockId));
  state.notes = (state.notes || []).filter((note) => !notes.includes(note));
  state.branches = (state.branches || []).filter((branch) => !branches.includes(branch));
  for (const note of notes) forgetNote(state, note.id);
  if (state.context?.ids) state.context.ids = state.context.ids.filter((id) => !moving.has(id));
  return { blocks, notes, branches, next, starts: groups.map((group) => group.blocks[0].id) };
}

// Puts messages taken out by takeMessages before the message containing beforeId (null: the end).
export function putMessages(state, { blocks, notes = [], branches = [] }, beforeId) {
  state.blocks.splice(startIndex(state, beforeId), 0, ...blocks);
  state.notes = [...(state.notes || []), ...notes];
  state.branches = [...(state.branches || []), ...branches];
}

// A margin annotation becomes a note block in the chat (below the message it was on, or before
// beforeId). The annotation is kept on the block so it can be turned back.
export function noteToBlock(state, noteId, beforeId) {
  const note = (state.notes || []).find((item) => item.id === noteId);
  if (!note) throw new Error("这条批注已不存在。");
  const block = { id: randomUUID(), kind: "paragraph", text: note.text, marks: [], included: true,
    ...(note.attachments?.length ? { attachments: cloned(note.attachments) } : {}), fromNote: stripTurns(cloned(note)) };
  const index = beforeId !== undefined ? startIndex(state, beforeId) : afterIndex(state, note.anchor?.blockId);
  state.blocks.splice(index, 0, block);
  state.notes = state.notes.filter((item) => item !== note);
  forgetNote(state, note.id);
  return block;
}

// Back from a note block to the annotation it came from (with the block's current text).
export function blockToNote(state, blockId) {
  const index = state.blocks.findIndex((block) => block.id === blockId);
  const block = state.blocks[index];
  if (!block?.fromNote) throw new Error("这个笔记块不是从批注转来的。");
  const note = { ...cloned(block.fromNote), text: block.text || block.fromNote.text };
  state.blocks.splice(index, 1);
  // Its passage may have moved away meanwhile: hang it on the nearest message above instead.
  if (!state.blocks.some((item) => item.id === note.anchor?.blockId && !item.removed)) {
    const near = state.blocks.slice(0, index).reverse().find((item) => !item.removed && item.text?.trim()) ??
      state.blocks.find((item) => !item.removed && item.text?.trim());
    if (!near) throw new Error("这个会话里没有可以挂批注的消息了。");
    const start = near.text.search(/\S/);
    note.anchor = { blockId: near.id, start, quote: near.text.slice(start).split(/\r?\n/, 1)[0].slice(0, 40) };
  }
  state.notes = [...(state.notes || []), note];
  return note;
}

// Removes whole messages (they stay as hidden placeholders); returns copies to put them back.
export function removeMessages(state, ids) {
  const blocks = messagesOf(state, ids).flatMap((group) => group.blocks).filter((block) => !block.removed);
  if (!blocks.length) throw new Error("这条消息已经移除了。");
  const backup = cloned(blocks);
  for (const block of blocks) {
    block.removed = true;
    block.text = "";
    block.marks = [];
    delete block.attachments;
  }
  return backup;
}

export function restoreMessages(state, backup) {
  for (const saved of backup) {
    const index = state.blocks.findIndex((block) => block.id === saved.id);
    if (index >= 0) state.blocks[index] = cloned(saved);
  }
}

// A deleted annotation is kept aside (with its follow-up chat) so the deletion can be undone.
export function removeNote(state, noteId) {
  const note = (state.notes || []).find((item) => item.id === noteId);
  if (!note) throw new Error("这条批注已不存在。");
  state.notes = state.notes.filter((item) => item !== note);
  forgetNote(state, noteId);
  state.removedNotes = [...(state.removedNotes || []), stripTurns(cloned(note))].slice(-60);
  return note;
}

export function restoreNote(state, noteId) {
  const note = (state.removedNotes || []).find((item) => item.id === noteId);
  if (!note) throw new Error("这条批注已无法恢复。");
  state.removedNotes = state.removedNotes.filter((item) => item !== note);
  state.notes = [...(state.notes || []), note];
  return note;
}
