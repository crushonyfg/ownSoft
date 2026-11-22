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
      annotationId: str, text: str }, ["kind", "annotationId", "text"]), method: "editAnnotation" }
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
