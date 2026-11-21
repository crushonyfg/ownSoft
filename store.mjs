import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { findAnchor, initialNotebook, splitReply } from "./notebook.mjs";

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
  for (const paragraph of splitReply(turn.answer)) {
    state.blocks.push({ id: randomUUID(), kind: "reply", text: paragraph, marks: [] });
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
  if (typeof value !== "string" || value.length > 60_000) throw new Error("段落最多 60,000 字符。");
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

export function applyChange(state, action) {
  switch (action.type) {
    case "add-blocks":
      state.blocks.push(...splitReply(requireText(action.text)).map((text) => ({
        id: randomUUID(), kind: "paragraph", text, marks: []
      })));
      break;
    case "edit-document":
      state.title = requireText(action.title, 160).trim();
      for (const { id, text, removed, included } of action.blocks) {
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
    const items = this.db.prepare("SELECT id, json_extract(snapshot, '$.title') AS title FROM notebook_documents ORDER BY updated DESC, rowid DESC").all();
    return { active: this.activeId(), items };
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

  create(title, { origin, turns = [] } = {}) {
    const state = { id: randomUUID(), title: requireText(title, 160).trim(), blocks: [], notes: [], branches: [] };
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

  change(action, id) {
    const state = applyChange(this.read(id), action);
    return this.write(state);
  }

  saveReply(branchId, question, answer, source, attachments = [], id) {
    const state = this.read(id);
    const turn = { id: randomUUID(), question, answer, source };
    if (attachments.length) turn.attachments = attachments;
    if (branchId) {
      find(state.branches, branchId).turns.push(turn);
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
