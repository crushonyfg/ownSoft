import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { NotebookTools } from "./notebook-tools.mjs";

const dataDir = process.env.AI_NOTEBOOK_DATA_DIR;
if (!dataDir) throw new Error("AI_NOTEBOOK_DATA_DIR is required");
const notebook = new NotebookTools(resolve(dataDir));
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
const num = { type: "integer", minimum: 0 };
const tools = [
  { name: "search_library", description: "Search chat and Markdown titles and text. Use this to find related notes before reading them.",
    inputSchema: schema({ query: str, limit: num }), method: "list", readOnly: true },
  { name: "read_chat", description: "Read a chat transcript and annotations in pages. Follow nextCursor to inspect beyond the local excerpt.",
    inputSchema: schema({ notebookId: str, cursor: num, limit: num }, ["notebookId"]), method: "readChat", readOnly: true },
  { name: "read_message", description: "Read one full chat message and its saved tool results, using offset to continue.",
    inputSchema: schema({ notebookId: str, messageId: str, offset: num, limit: num }, ["notebookId", "messageId"]), method: "readMessage", readOnly: true },
  { name: "resolve_message_id", description: "Find which chat and message contain a given message or paragraph ID.",
    inputSchema: schema({ messageId: str }, ["messageId"]), method: "resolveMessage", readOnly: true },
  { name: "read_markdown", description: "Read a Markdown document and its annotations in chunks. Follow nextOffset for more text.",
    inputSchema: schema({ mdId: str, offset: num, limit: num }, ["mdId"]), method: "readMarkdown", readOnly: true },
  { name: "read_annotation", description: "Read one full annotation and find its follow-up chat ID, if it has one.",
    inputSchema: schema({ kind: { enum: ["chat", "md", "pdf"] }, notebookId: str, mdId: str, hash: str,
      annotationId: str }, ["kind", "annotationId"]), method: "readAnnotation", readOnly: true },
  { name: "read_pdf_review", description: "List a PDF review's annotations and its local PDF path so you can inspect other pages with your file tools.",
    inputSchema: schema({ hash: str, cursor: num, limit: num }, ["hash"]), method: "readPdfReview", readOnly: true },
  { name: "save_markdown", description: "Create or update a Markdown document in AI Notebook. Optionally add it as a linked note block in a chat. Use only when the user asks to save work.",
    inputSchema: schema({ mdId: str, name: str, text: str, notebookId: str, afterId: str }, ["name", "text"]), method: "saveMarkdown" },
  { name: "import_markdown", description: "Import an existing local .md/.txt file into AI Notebook and optionally insert it as a linked note block. The file remains editable in the Markdown view.",
    inputSchema: schema({ path: str, notebookId: str, afterId: str }, ["path"]), method: "importMarkdown" },
  { name: "add_note_block", description: "Insert a shared text note block in a chat. Internal links may use [label](ownsoft://chat/UUID) or [label](ownsoft://md/UUID).",
    inputSchema: schema({ notebookId: str, text: str, afterId: str }, ["notebookId", "text"]), method: "addNoteBlock" },
  { name: "insert_markdown_block", description: "Insert an existing Markdown document as a linked note block in a chat, without resending its text.",
    inputSchema: schema({ notebookId: str, mdId: str, afterId: str }, ["notebookId", "mdId"]), method: "insertMarkdownBlock" },
  { name: "add_annotation", description: "Annotate a chat message, Markdown passage, or PDF page. Chat needs notebookId/blockId/quote; MD needs mdId/quote; PDF needs hash/page and creates a text-only page annotation.",
    inputSchema: schema({ kind: { enum: ["chat", "md", "pdf"] }, notebookId: str, mdId: str, hash: str,
      blockId: str, page: num, quote: str, text: str, title: str }, ["kind", "text"]), method: "annotate" },
  { name: "edit_annotation", description: "Change the text of a chat, Markdown, or PDF annotation by ID.",
    inputSchema: schema({ kind: { enum: ["chat", "md", "pdf"] }, notebookId: str, mdId: str, hash: str,
      annotationId: str, text: str }, ["kind", "annotationId", "text"]), method: "editAnnotation" },
  { name: "move_message_to_annotation", description: "Move a complete message from one chat to an annotation anchored in another chat. First resolve the target message ID and read its text to choose an exact quote and offset.",
    inputSchema: schema({ sourceId: str, messageIds: { type: "array", items: str, minItems: 1 }, targetId: str,
      anchor: schema({ blockId: str, start: num, quote: str }, ["blockId", "start", "quote"]) },
    ["sourceId", "messageIds", "targetId", "anchor"]), method: "moveMessageToAnnotation" },
  { name: "list_todos", description: "List the user's to-dos (AI Notebook's todo list and calendar): text, due time, repeat, status (open, ran = done by AI and waiting for the user, done), source chat.",
    inputSchema: schema({ status: { enum: ["open", "ran", "done"] }, limit: num }), method: "listTodos", readOnly: true },
  { name: "add_todo", description: "Add a to-do, optionally at a time for the AI to do it then (it runs in the to-do's own chat, with the source message as context). Give either dueAt (local date-time like 2026-12-01T09:00) or after {amount, unit: minute|hour|day|week|month}. When working on a to-do and something should be looked at again later, add a follow-up with fromTodoId (it keeps the same source message), or reschedule the current one with update_todo.",
    inputSchema: schema({ text: str, dueAt: str, after: schema({ amount: { type: "number", exclusiveMinimum: 0 },
      unit: { enum: ["minute", "hour", "day", "week", "month"] } }, ["amount", "unit"]),
      repeat: schema({ every: { type: "integer", minimum: 1, maximum: 365 }, unit: { enum: ["day", "week", "month"] } }, ["every", "unit"]),
      notebookId: str, messageId: str, quote: str, fromTodoId: str, memberId: str, ai: { type: "boolean" } }, ["text"]), method: "addTodo" },
  { name: "update_todo", description: "Change a to-do: reschedule it (dueAt or after; it becomes open again), reword it, change or clear its repeat (null), or mark it done / open. Use this when a to-do turns out to need another look later, instead of leaving it done.",
    inputSchema: schema({ todoId: str, text: str, dueAt: str, after: schema({ amount: { type: "number", exclusiveMinimum: 0 },
      unit: { enum: ["minute", "hour", "day", "week", "month"] } }, ["amount", "unit"]),
      repeat: { anyOf: [schema({ every: { type: "integer", minimum: 1, maximum: 365 }, unit: { enum: ["day", "week", "month"] } }, ["every", "unit"]), { type: "null" }] },
      status: { enum: ["open", "done"] }, ai: { type: "boolean" } }, ["todoId"]), method: "updateTodo" },
  { name: "undo_message_annotation", description: "Undo a message-to-annotation conversion and restore the source message. The annotation must have no follow-up chat turns.",
    inputSchema: schema({ targetId: str, noteId: str }, ["targetId", "noteId"]), method: "undoMessageAnnotation" }
];
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const line = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function request(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  try {
    let result;
    if (method === "initialize") result = { protocolVersion: params.protocolVersion || "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "ownsoft", version: "0.4.0" } };
    else if (method === "ping") result = {};
    else if (method === "tools/list") result = { tools: tools.map(({ method: _method, readOnly, ...tool }) => ({
      ...tool, annotations: { readOnlyHint: Boolean(readOnly), destructiveHint: false,
        idempotentHint: Boolean(readOnly) } })) };
    else if (method === "tools/call") {
      const tool = byName.get(params.name);
      if (!tool) throw new Error("Unknown tool");
      try {
        const value = await notebook[tool.method](params.arguments || {});
        result = { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: error.message }] };
      }
    } else throw new Error(`Unknown method: ${method}`);
    line({ jsonrpc: "2.0", id, result });
  } catch (error) {
    line({ jsonrpc: "2.0", id, error: { code: -32601, message: error.message } });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const row of input) {
  try { await request(JSON.parse(row)); }
  catch (error) { process.stderr.write(`${error.message}\n`); }
}
notebook.close();
