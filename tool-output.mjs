// Preserve the readable result locally. Only the prompt builder decides how much of it to reuse;
// binary payloads are never copied into the chat history.
const keys = ["content", "contentItems", "structuredContent", "text", "output", "aggregatedOutput", "stdout", "result", "results",
  "title", "url", "description", "summary", "snippet"];

export function toolOutput(value, limit = 200_000) {
  const pieces = [];
  let remaining = limit + 1;
  const visit = (part, depth = 0) => {
    if (remaining <= 0 || depth > 4 || part == null) return;
    if (typeof part === "string") {
      const clean = part.replace(/\x1b\[[0-9;]*m/g, "").replace(/\0/g, "").trim();
      if (clean) {
        const excerpt = clean.slice(0, remaining);
        pieces.push(excerpt);
        remaining -= excerpt.length;
      }
    } else if (Array.isArray(part)) {
      for (const item of part) visit(item, depth + 1);
    } else if (typeof part === "object" && !ArrayBuffer.isView(part)) {
      const known = keys.filter((key) => key in part);
      if (known.length) for (const key of known) visit(part[key], depth + 1);
      else for (const [key, item] of Object.entries(part).slice(0, 12)) {
        if (/^(?:data|image|audio|blob|bytes|base64)$/i.test(key)) continue;
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          visit(`${key}: ${String(item)}`, depth + 1);
        }
      }
    }
  };
  visit(value);
  const result = pieces.join("\n").slice(0, limit);
  return result + (remaining <= 0 ? "\n…（工具结果已截断）" : "");
}
