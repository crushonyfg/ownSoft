import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";
import { decodeString } from "micromark-util-decode-string";
import katex from "katex";
import { mathFromMarkdown, mathSyntax } from "./math.mjs";

const options = { extensions: [gfm(), cjkFriendlyExtension(), mathSyntax],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown] };

// Typesets one formula; a formula KaTeX cannot read shows its source instead of breaking the page.
export function renderMath(target, value, display) {
  try {
    katex.render(value, target, { displayMode: display, throwOnError: false, strict: "ignore", trust: false,
      output: "htmlAndMathml" });
  } catch {
    target.textContent = value;
    target.classList.add("math-error");
  }
}

export function parseMarkdown(source) {
  return fromMarkdown(source, options);
}

export function splitMarkdown(source) {
  const text = source.replaceAll("\r\n", "\n");
  const blocks = parseMarkdown(text).children;
  // Reference definitions can be used by any block in this reply.
  if (blocks.some(({ type }) => type === "definition" || type === "footnoteDefinition")) return [text.trim()];
  return blocks.map(({ position }) => text.slice(position.start.offset, position.end.offset));
}

const characterReference = /&(?:#[xX][\da-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][\da-zA-Z]{0,31});/y;
const punctuation = /[!-/:-@[-`{-~]/;

// Each pair maps one displayed UTF-16 unit to its span in the saved source.
export function textOffsets(source, value, start, end, decode = true) {
  const offsets = new Uint32Array(value.length * 2);
  let raw = start;
  let visible = 0;
  while (visible < value.length) {
    let width = 1;
    let length = 1;
    if (raw < end) {
      let decoded = "";
      if (source[raw] === "\r" && value[visible] === "\n") {
        decoded = "\n";
        width = source[raw + 1] === "\n" ? 2 : 1;
      } else if (source[raw] === "\t" && value[visible] === " ") {
        decoded = " ";
      } else if (decode && source[raw] === "\\" && punctuation.test(source[raw + 1] || "")) {
        decoded = source[raw + 1];
        width = 2;
      } else if (decode && source[raw] === "&") {
        characterReference.lastIndex = raw;
        const entity = characterReference.exec(source)?.[0];
        if (entity) {
          decoded = decodeString(entity);
          width = entity.length;
        }
      }
      if (decoded && raw + width <= end && value.startsWith(decoded, visible)) {
        length = decoded.length;
      } else if (source[raw] !== value[visible]) {
        const next = source.indexOf(value[visible], raw + 1);
        if (next >= 0 && next < end) raw = next;
        width = 1;
      } else {
        width = 1;
      }
    }
    const rawEnd = Math.min(end, raw + width);
    for (let unit = 0; unit < length; unit += 1) {
      offsets[(visible + unit) * 2] = raw;
      offsets[(visible + unit) * 2 + 1] = rawEnd;
    }
    raw = rawEnd;
    visible += length;
  }
  return offsets;
}
