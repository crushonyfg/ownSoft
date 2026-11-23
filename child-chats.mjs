// Every conversation is a chat. Annotation follow-ups, side branches, private windows and the
// conversations of PDF and Markdown reviews are stored as chats of their own ("child chats") with a
// `parent` saying where they grew from. The places that show them as a compact list of
// question/answer turns read those turns from the chat and write new ones into it, so the same
// conversation can also be opened as a full chat with everything the main chat can do.
import { randomUUID } from "node:crypto";
import { messageGroups, splitReply } from "./notebook.mjs";

const live = (block) => !block.removed;

// The chat as turns: one per answer, with the question it answers. A turn's id is the id of its
// answer's first paragraph, so edits made through either view meet in the same place.
export function chatTurns(chat) {
  const turns = [];
  let question = null;
  let fresh = false;
  for (const group of messageGroups(chat.blocks)) {
    const first = group.blocks[0];
    if (group.kind === "question") {
      question = live(first) ? first : null;
      fresh = true;
      continue;
    }
    if (group.kind !== "reply") continue;
    const blocks = group.blocks.filter(live);
    const answer = blocks.map((block) => block.text).join("\n\n").trim();
    if (!answer) continue;
    const source = first.source ?? question?.source;
    const tools = group.blocks.find((block) => block.tools?.length)?.tools;
    const files = fresh ? question?.attachments : undefined;
    turns.push({ id: first.id, question: question?.text.trim() || "（继续）", answer,
      ...(source ? { source } : {}), ...(tools ? { tools } : {}), ...(files?.length ? { attachments: files } : {}) });
    fresh = false;
  }
  return turns;
}

function replyBlocks(turn, turnId = randomUUID()) {
  return splitReply(turn.answer).map((text, index) => ({
    id: index === 0 ? turn.id : randomUUID(), kind: "reply", turnId, text, marks: [],
    ...(index === 0 && turn.source ? { source: turn.source } : {}),
    ...(index === 0 && turn.tools?.length ? { tools: turn.tools } : {})
  }));
}

function lastQuestion(chat) {
  const groups = messageGroups(chat.blocks).filter((group) => group.blocks.some(live));
  const last = groups.at(-1);
  if (last?.kind !== "reply") return null;
  return groups.findLast((group) => group.kind === "question")?.blocks[0] ?? null;
}

// Adds a turn at the end. An answer to the question just asked (another member answering the
// same question) goes under that question instead of repeating it.
export function appendTurn(chat, turn) {
  const previous = lastQuestion(chat);
  if (!previous || previous.removed || previous.text.trim() !== turn.question.trim()) {
    chat.blocks.push({ id: randomUUID(), kind: "question", text: turn.question, marks: [],
      ...(turn.source ? { source: turn.source } : {}), ...(turn.attachments?.length ? { attachments: turn.attachments } : {}) });
  }
  chat.blocks.push(...replyBlocks(turn));
}

function removeGroup(chat, firstId) {
  const group = messageGroups(chat.blocks).find((item) => item.blocks[0].id === firstId);
  for (const block of group?.blocks || []) Object.assign(block, { removed: true, text: "", marks: [] });
}

// Brings the chat in line with a list of turns. New turns are appended and changed answers
// updated; with prune, answers missing from the list are removed (and questions left without
// answers). Returns whether anything changed.
export function syncTurns(chat, turns, { prune = false } = {}) {
  const current = new Map(chatTurns(chat).map((turn) => [turn.id, turn]));
  let changed = false;
  for (const turn of turns) {
    const existing = current.get(turn.id);
    if (!existing) {
      appendTurn(chat, turn);
      changed = true;
      continue;
    }
    current.delete(turn.id);
    if (existing.answer !== turn.answer.trim()) {
      const group = messageGroups(chat.blocks).find((item) => item.blocks[0].id === turn.id);
      const [first, ...rest] = group.blocks;
      first.text = turn.answer.trim();
      delete first.removed;
      for (const block of rest) Object.assign(block, { removed: true, text: "", marks: [] });
      changed = true;
    }
    if (existing.question !== turn.question.trim()) {
      const groups = messageGroups(chat.blocks);
      const at = groups.findIndex((item) => item.blocks[0].id === turn.id);
      const asked = groups.slice(0, at).findLast((item) => item.kind === "question")?.blocks[0];
      if (asked && turn.question.trim()) {
        asked.text = turn.question.trim();
        changed = true;
      }
    }
  }
  if (prune && current.size) {
    // Questions whose answers this removes go too when nothing else answers them (a question
    // still waiting for its answer is left alone).
    const groups = messageGroups(chat.blocks);
    const orphaned = new Set();
    for (const id of current.keys()) {
      const at = groups.findIndex((item) => item.blocks[0].id === id);
      const asked = groups.slice(0, at).findLast((item) => item.kind === "question")?.blocks[0];
      if (asked) orphaned.add(asked);
      removeGroup(chat, id);
    }
    const after = messageGroups(chat.blocks);
    for (const asked of orphaned) {
      const at = after.findIndex((item) => item.blocks[0] === asked);
      const next = after.slice(at + 1).findIndex((item) => item.kind === "question");
      const answers = after.slice(at + 1, next < 0 ? undefined : at + 1 + next);
      if (!answers.some((item) => item.kind === "reply" && item.blocks.some(live))) {
        Object.assign(asked, { removed: true, text: "", marks: [] });
      }
    }
    changed = true;
  }
  return changed;
}

// Where each kind of conversation lives, and how a child chat is named.
export const childKey = {
  note: (notebookId, noteId) => `note:${notebookId}:${noteId}`,
  branch: (notebookId, branchId) => `branch:${notebookId}:${branchId}`,
  thread: (notebookId, threadId) => `thread:${notebookId}:${threadId}`,
  pdfChat: (hash) => `pdf-chat:${hash}`,
  pdfComment: (hash, commentId) => `pdf-comment:${hash}:${commentId}`,
  mdChat: (id) => `md-chat:${id}`,
  mdComment: (id, commentId) => `md-comment:${id}:${commentId}`,
  todo: (id) => `todo:${id}`
};

export const childKinds = {
  note: "批注追问", branch: "分支", thread: "私聊", "pdf-chat": "PDF 全文对话", "pdf-comment": "PDF 批注追问",
  "md-chat": "文档全文对话", "md-comment": "文档批注追问", todo: "待办"
};
