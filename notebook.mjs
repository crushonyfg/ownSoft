import { splitMarkdown } from "./markdown.mjs";

export function initialNotebook() {
  return {
    title: "我的工作笔记",
    blocks: [
      { id: "starter-1", kind: "paragraph", text: "把要阅读和整理的回答放进这份笔记。选中一句话，可以加高亮、写批注，或者打开侧边对话继续追问。", marks: [], included: false },
      { id: "starter-2", kind: "paragraph", text: "新分支从你选中的段落开始。侧边回答中有用的解释，可以摘成页边批注，留在原文旁。", marks: [], included: false }
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

const includedBlock = (block) => !block.removed && block.included !== false;

// Paragraphs of one reply share a turnId; replies from different group members stay separate
// messages. Older replies have no turnId and merge with their neighbours, as before.
export function sameMessage(previous, block) {
  return previous?.kind === "reply" && block?.kind === "reply" && (previous.turnId ?? null) === (block.turnId ?? null);
}

export function messageGroups(blocks) {
  const groups = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (last && sameMessage(last.blocks.at(-1), block)) last.blocks.push(block);
    else groups.push({ kind: block.kind, blocks: [block] });
  }
  return groups;
}

// The main chat's context: every earlier message, or (once chosen) only the chosen messages plus
// everything added after the choice, so the conversation can carry on from there.
export function contextBlockIds(notebook) {
  const chosen = notebook.context;
  if (!chosen || !Array.isArray(chosen.ids)) return null;
  const ids = new Set(chosen.ids);
  const allowed = new Set();
  for (const group of messageGroups(notebook.blocks)) {
    if (ids.has(group.blocks[0].id)) for (const block of group.blocks) allowed.add(block.id);
  }
  const cutoff = notebook.blocks.findIndex((block) => block.id === chosen.cutoff);
  for (const block of notebook.blocks.slice(cutoff + 1)) allowed.add(block.id);
  return allowed;
}

export function mainHistory(notebook) {
  const history = [];
  let turn;
  let previous;
  const allowed = contextBlockIds(notebook);
  const included = (block) => includedBlock(block) && (!allowed || allowed.has(block.id));
  for (const block of notebook.blocks) {
    if (block.kind === "question") {
      turn = { question: included(block) ? block.text.trim() : "", replies: [],
        attachments: included(block) ? block.attachments || [] : [] };
      history.push(turn);
    } else if (block.kind === "reply" && turn) {
      if (!sameMessage(previous, block) || !turn.replies.length) turn.replies.push({ speaker: block.source?.memberName, texts: [] });
      if (included(block) && block.text.trim()) turn.replies.at(-1).texts.push(block.text);
    }
    if (block.kind !== "paragraph") previous = block;
  }
  return history.map(({ question, replies, attachments }) => {
    const spoken = replies.filter((reply) => reply.texts.length);
    const labelled = spoken.some((reply) => reply.speaker);
    const answer = spoken.map((reply) => (labelled && reply.speaker ? `【${reply.speaker}】\n` : "") +
      reply.texts.join("\n\n")).join("\n\n");
    return { question, answer, attachments };
  }).filter((turn) => turn.question || turn.answer || turn.attachments.length);
}

export function sharedNoteIncluded(block) {
  return !block.removed && block.included !== false &&
    (block.included === true || !["starter-1", "starter-2"].includes(block.id));
}

export function sharedNoteBlocks(notebook) {
  const allowed = contextBlockIds(notebook);
  return notebook.blocks.filter((block) => block.kind === "paragraph" && sharedNoteIncluded(block) &&
    (!allowed || allowed.has(block.id)));
}

// A PDF review's annotations as plain text: page, quoted passage and the note on it.
export function reviewCommentsText(comments = []) {
  return comments.map((item) => `- 第 ${item.page} 页${item.quote ? `「${item.quote.replace(/\s+/g, " ").slice(0, 160)}」` : ""}` +
    `${item.title ? `（${item.title}）` : ""}：${item.text}`).join("\n");
}

function sharedNoteText(block) {
  const file = block.attachments?.[0]?.name;
  if (block.noteType === "image") return `图片「${file || "图片"}」：${block.text}`;
  if (block.noteType === "pdf") {
    const comments = reviewCommentsText(block.review?.comments);
    return [`PDF「${file || block.text}」（文件在下面的附件文件里，需要时打开）`, comments && `这份 PDF 的审阅批注：\n${comments}`]
      .filter(Boolean).join("\n");
  }
  if (block.noteType === "thread") return `分头讨论记录（用户与 ${block.source?.memberName || "成员"} 单独对话后发布）：\n${block.text}`;
  return block.text;
}

export function sharedNoteContext(notebook) {
  const content = sharedNoteBlocks(notebook).map(sharedNoteText).filter(Boolean).join("\n\n");
  return [commentContext(notebook.origin), content && `公共笔记：\n${content}`].filter(Boolean).join("\n\n");
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

// Annotations chosen as main-chat context (by default none are), with the passage each one marks.
export function contextNotes(notebook) {
  const ids = new Set(notebook.context?.notes || []);
  return notebook.notes.filter((note) => ids.has(note.id));
}

function annotationContext(notebook) {
  const notes = contextNotes(notebook);
  if (!notes.length) return "";
  return "选入的批注：\n" + notes.map((note) =>
    `- ${note.author || "批注"}（标在「${note.anchor.label || note.anchor.quote}」旁）：${note.text}`).join("\n");
}

export function turnInput(notebook, branch, question) {
  if (!branch) {
    return {
      context: [sharedNoteContext(notebook), annotationContext(notebook)].filter(Boolean).join("\n\n"),
      memories: notebook.notes.filter((note) => note.pinned && (notebook.mainMemoryIds || []).includes(note.id))
        .map((note) => note.text),
      history: mainHistory(notebook).map(({ question, answer }) => ({ question, answer })),
      question
    };
  }
  return {
    context: [branch.context, sharedNoteContext(notebook)].filter(Boolean).join("\n\n"),
    memories: notebook.notes.filter((note) => note.pinned && branch.memoryIds.includes(note.id))
      .map((note) => note.text),
    history: branch.turns.map(({ question, answer }) => ({ question, answer })),
    question
  };
}

// A side conversation with one member: the main chat's context, then this window's own turns.
// Other members do not see it until the user publishes it into the chat.
export function threadInput(notebook, thread, question) {
  const input = turnInput(notebook, null, question);
  input.history = [...input.history, ...thread.turns.map(({ question: asked, answer }) => ({ question: asked, answer }))];
  const origin = thread.origin;
  input.context = ["这是用户和你的单独对话（私聊小窗）。它基于群聊的笔记和对话，但群里其他成员看不到，除非用户把它发布到群聊。",
    origin && `用户是从群聊里的这条消息开始和你单独聊的${origin.speaker ? `（${origin.speaker} 说的）` : ""}：\n${origin.text}`,
    input.context].filter(Boolean).join("\n\n");
  return input;
}

// A conversation about a whole PDF: its annotations are context; the PDF text is attached separately.
export function documentOrigin(name, comments = []) {
  const notes = reviewCommentsText(comments);
  return {
    kind: "selection", reference: name,
    text: ["这是关于整份 PDF 的对话，PDF 文件和抽取好的文字在附件文件里，需要时打开阅读。", notes && `已有的审阅批注：\n${notes}`].filter(Boolean).join("\n\n")
  };
}

// Models sometimes sign their answer anyway ("claude2：…", "【claude2】…"); the name is shown already.
export function stripSpeaker(answer, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return answer.replace(new RegExp(`^\\s*(?:【${escaped}】|\\*\\*${escaped}\\*\\*\\s*[:：]|${escaped}\\s*[:：])\\s*`, "i"), "").trim() || answer;
}
