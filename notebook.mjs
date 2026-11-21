import { splitMarkdown } from "./markdown.mjs";

export function initialNotebook() {
  return {
    title: "我的工作笔记",
    blocks: [
      { id: "starter-1", kind: "paragraph", text: "把要阅读和整理的回答放进这份笔记。选中一句话，可以加高亮、写批注，或者打开侧边对话继续追问。", marks: [] },
      { id: "starter-2", kind: "paragraph", text: "新分支从你选中的段落开始。侧边回答中有用的解释，可以摘成页边批注，留在原文旁。", marks: [] }
    ],
    notes: [],
    branches: []
  };
}

export function findAnchor(text, { start, quote }) {
  if (!quote) return null;
  if (text.slice(start, start + quote.length) === quote) return start;
  const first = text.indexOf(quote);
  return first >= 0 && text.indexOf(quote, first + 1) === -1 ? first : null;
}

export function splitReply(reply) {
  return splitMarkdown(reply);
}

const included = (block) => !block.removed && block.included !== false;

export function mainHistory(notebook) {
  const history = [];
  let turn;
  for (const block of notebook.blocks) {
    if (block.kind === "question") {
      turn = { question: included(block) ? block.text.trim() : "", replies: [],
        attachments: included(block) ? block.attachments || [] : [] };
      history.push(turn);
    } else if (block.kind === "reply" && turn && included(block) && block.text.trim()) {
      turn.replies.push(block.text);
    }
  }
  return history.map(({ question, replies, attachments }) => ({ question, answer: replies.join("\n\n"), attachments }))
    .filter((turn) => turn.question || turn.answer || turn.attachments.length);
}

export function noteOrigin(notebook, note) {
  const block = notebook.blocks.find((item) => item.id === note.anchor.blockId);
  return {
    kind: "note", reference: notebook.title, title: note.author || "批注",
    quote: note.anchor.label || note.anchor.quote, text: note.text,
    paragraph: block && !block.removed && findAnchor(block.text, note.anchor) !== null ? block.text : ""
  };
}

export function pdfCommentOrigin(name, comment) {
  return {
    kind: "pdf", reference: `${name} · 第 ${comment.page} 页`, title: comment.title || "PDF 批注",
    quote: comment.quote, text: comment.text
  };
}

export function commentContext(origin) {
  if (!origin) return "";
  return [
    `来源：${origin.reference}`,
    origin.quote && `原文引句：\n${origin.quote}`,
    origin.paragraph && origin.paragraph !== origin.quote && `所在段落：\n${origin.paragraph}`,
    origin.kind === "selection" ? origin.text : `批注：\n${origin.text}`
  ].filter(Boolean).join("\n\n");
}

export function commentInput(origin, turns, question) {
  return {
    context: commentContext(origin), memories: [],
    history: turns.map(({ question, answer }) => ({ question, answer })), question
  };
}

export function turnInput(notebook, branch, question) {
  if (!branch) {
    return {
      context: commentContext(notebook.origin),
      memories: notebook.notes.filter((note) => note.pinned && (notebook.mainMemoryIds || []).includes(note.id))
        .map((note) => note.text),
      history: mainHistory(notebook).map(({ question, answer }) => ({ question, answer })),
      question
    };
  }
  return {
    context: branch.context,
    memories: notebook.notes.filter((note) => note.pinned && branch.memoryIds.includes(note.id))
      .map((note) => note.text),
    history: branch.turns.map(({ question, answer }) => ({ question, answer })),
    question
  };
}
