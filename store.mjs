import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { applyMemberChange } from "./members.mjs";
import { DatabaseSync } from "node:sqlite";
import { findAnchor, initialNotebook, messageGroups, sameMessage, splitReply } from "./notebook.mjs";

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

// Index of the first block of the message containing beforeId.
function messageStart(state, beforeId) {
  let index = state.blocks.findIndex((block) => block.id === beforeId);
  if (index < 0) throw new Error("笔记块已改变，请重试。");
  while (index > 0 && sameMessage(state.blocks[index - 1], state.blocks[index])) index -= 1;
  return index;
}

export function applyChange(state, action) {
  switch (action.type) {
    case "add-shared-block":
      state.blocks.splice(insertionIndex(state, action.afterId), 0, {
        id: randomUUID(), kind: "paragraph", text: requireText(action.text, 160_000).trim(),
        marks: [], included: action.included !== false });
      break;
    case "add-note-images":
      if (!Array.isArray(action.refs) || !action.refs.length || action.refs.length > 6 ||
          action.refs.some((ref) => ![".png", ".jpg", ".jpeg", ".webp"].includes(ref.extension))) {
        throw new Error("请选择最多 6 张图片。");
      }
      state.blocks.splice(insertionIndex(state, action.afterId), 0, ...action.refs.map((ref) => ({
        id: randomUUID(), kind: "paragraph", noteType: "image", text: ref.name,
        attachments: [ref], marks: [], included: true
      })));
      break;
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
      const live = blocks.filter((block) => !block.removed);
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
      const attachments = live.flatMap((block) => block.attachments || []);
      const text = live.map((block) => block.text).join("\n\n").trim() ||
        (attachments.length ? `（附件：${attachments.map((ref) => ref.name).join("、")}）` : "");
      if (!text) throw new Error("这条消息是空的。");
      const speaker = blocks[0].source;
      const author = blocks[0].kind === "question" ? "我的消息" : blocks[0].kind === "paragraph" ? "笔记块"
        : `${speaker?.memberName || (speaker?.provider === "claude" ? "Claude" : speaker?.provider === "gemini" ? "Gemini" : "GPT")} 的回答`;
      state.notes.push({ id: randomUUID(), anchor, text: requireText(text, 160_000),
        author, pinned: false, ...(attachments.length ? { attachments } : {}), ...(speaker ? { source: speaker } : {}) });
      for (const block of blocks) {
        block.removed = true;
        block.text = "";
        block.marks = [];
        delete block.attachments;
      }
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
    return JSON.parse(row.snapshot);
  }

  readAll() {
    return this.db.prepare("SELECT snapshot FROM notebook_documents").all().map(({ snapshot }) => JSON.parse(snapshot));
  }

  library() {
    const items = this.db.prepare(`SELECT id, json_extract(snapshot, '$.title') AS title,
      json_extract(snapshot, '$.folderId') AS folderId
      FROM notebook_documents ORDER BY updated DESC, rowid DESC`).all();
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
      if (this.activeId() === id) {
        const replacement = this.db.prepare("SELECT id FROM notebook_documents ORDER BY updated DESC, rowid DESC LIMIT 1").get();
        this.db.prepare("UPDATE notebook_library SET active = ? WHERE id = 1").run(replacement.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { state: this.read(), ...this.library() };
  }

  recentReview() {
    return this.db.prepare("SELECT path, name, page FROM recent_pdf_review WHERE id = 1").get();
  }

  rememberReview(path, name, page) {
    this.db.prepare(`INSERT INTO recent_pdf_review VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name, page = excluded.page`).run(path, name, page);
  }

  open(id) {
    const state = this.read(id);
    this.db.prepare("UPDATE notebook_library SET active = ? WHERE id = 1").run(state.id);
    return { state, ...this.library() };
  }

  create(title, { origin, turns = [], folderId } = {}) {
    const state = { id: randomUUID(), title: requireText(title, 160).trim(), blocks: [], notes: [], branches: [] };
    const folder = this.checkedFolder(folderId);
    if (folder) state.folderId = folder;
    if (origin) state.origin = origin;
    for (const turn of turns) appendMainTurn(state, { ...turn, id: randomUUID() });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insert.run(state.id, JSON.stringify(state), Date.now());
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
      this.insert.run(state.id, JSON.stringify(state), Date.now());
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

  // A chat's members start as a copy of the app's default roster the first time they are changed.
  changeMembers(id, action, settings, avatarFor) {
    const state = this.read(id);
    const roster = state.members?.length ? { members: state.members, defaultMember: state.defaultMember }
      : { members: structuredClone(settings.members || []), defaultMember: settings.defaultMember };
    const result = applyMemberChange(roster, action, settings.profiles, avatarFor);
    Object.assign(state, { members: roster.members, defaultMember: roster.defaultMember });
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
  saveReply(branchId, question, answer, source, attachments = [], id, tools = [], { continueTurn = false } = {}) {
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
    this.update.run(JSON.stringify(state), Date.now(), state.id);
    return state;
  }

  close() {
    this.db.close();
  }
}
