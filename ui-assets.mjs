import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const types = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };

export async function fileAsset(path) {
  try { return new Response(await readFile(path), { headers: { "Content-Type": types[extname(path)] || "application/octet-stream" } }); }
  catch (error) { if (error.code === "ENOENT") return new Response(null, { status: 404 }); throw error; }
}

// One running backend serves one matching UI version, including newly opened embedded chats.
// Development edits on disk must not silently give old backends a newer, incompatible page.
export async function uiAssets(base, files) {
  const assets = new Map(await Promise.all([...files].map(async ([url, file]) => [url,
    { bytes: await readFile(join(base, file)), type: types[extname(file)] || "application/octet-stream" }])));
  return (path) => {
    const item = assets.get(path);
    return item ? new Response(item.bytes, { headers: { "Content-Type": item.type } }) : new Response(null, { status: 404 });
  };
}
