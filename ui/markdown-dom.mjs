import { parseMarkdown, textOffsets } from "./markdown.mjs";

const sourceOffsets = new WeakMap();
const inlineTags = { emphasis: "em", strong: "strong", delete: "del" };
const blockTags = { paragraph: "p", blockquote: "blockquote", listItem: "li" };
const markClasses = { highlight: "highlighted", underline: "underlined", note: "has-note" };

function element(parent, tag) {
  const child = document.createElement(tag);
  parent.append(child);
  return child;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    // Relative or malformed links are rendered as text.
  }
}

export function renderMarkdown(target, source, { literal = false, marks = null } = {}) {
  target.replaceChildren();
  const tree = literal ? null : parseMarkdown(source);
  const definitions = new Map(tree?.children.filter(({ type }) => type === "definition")
    .map((node) => [node.identifier, node]));

  function write(parent, value, start, end, decode = true) {
    if (!value) return;
    if (!marks) {
      parent.append(value);
      return;
    }
    const offsets = textOffsets(source, value, start, end, decode);
    const classesAt = (index) => marks.filter((mark) => offsets[index * 2] < mark.end &&
      offsets[index * 2 + 1] > mark.start).map((mark) => markClasses[mark.style]).join(" ");
    let from = 0;
    let classes = marks.length ? classesAt(0) : "";
    for (let index = 1; index <= value.length; index += 1) {
      const next = index < value.length && marks.length ? classesAt(index) : "";
      if (index < value.length && classes === next) continue;
      const text = document.createTextNode(value.slice(from, index));
      const container = classes ? element(parent, "span") : parent;
      if (classes) container.className = classes;
      container.append(text);
      sourceOffsets.set(text, offsets.subarray(from * 2, index * 2));
      from = index;
      classes = next;
    }
  }

  function render(parent, node) {
    const { type, children, position } = node;
    const start = position.start.offset;
    const end = position.end.offset;
    const descend = (container) => children.forEach((child) => render(container, child));
    if (inlineTags[type] || blockTags[type] || type === "heading") {
      const tag = inlineTags[type] || blockTags[type] || `h${node.depth}`;
      const container = element(parent, tag);
      if (type === "listItem" && node.checked !== null && node.checked !== undefined) {
        const check = element(container, "input");
        check.type = "checkbox";
        check.checked = node.checked;
        check.disabled = true;
        container.className = "task-item";
      }
      descend(container);
      return;
    }
    switch (type) {
      case "text":
      case "html":
        write(parent, node.value, start, end, type === "text");
        break;
      case "inlineCode": {
        const fence = source.slice(start, end).match(/^`+/)?.[0].length || 0;
        write(element(parent, "code"), node.value, start + fence, end - fence, false);
        break;
      }
      case "code": {
        const fence = source.slice(start, end).match(/^(?:`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/)?.[0].length || 0;
        write(element(element(parent, "pre"), "code"), node.value, start + fence, end, false);
        break;
      }
      case "list": {
        const list = element(parent, node.ordered ? "ol" : "ul");
        if (node.ordered && node.start !== null && node.start !== undefined) list.start = node.start;
        descend(list);
        break;
      }
      case "link":
      case "linkReference": {
        const url = safeUrl(type === "link" ? node.url : definitions.get(node.identifier)?.url);
        const link = url ? element(parent, "a") : parent;
        if (url) {
          link.href = url;
          link.dataset.markdownLink = url;
        }
        descend(link);
        break;
      }
      case "image":
      case "imageReference": {
        const label = element(parent, "span");
        label.className = "markdown-image-label";
        if (node.alt) write(label, node.alt, start + 2, end);
        else label.textContent = "图片";
        break;
      }
      case "break":
        element(parent, "br");
        break;
      case "thematicBreak":
        element(parent, "hr");
        break;
      case "table": {
        const wrapper = element(parent, "div");
        wrapper.className = "markdown-table";
        const table = element(wrapper, "table");
        const header = element(table, "thead");
        const body = element(table, "tbody");
        children.forEach((row, rowIndex) => {
          const tr = element(rowIndex === 0 ? header : body, "tr");
          row.children.forEach((cell, column) => {
            const td = element(tr, rowIndex === 0 ? "th" : "td");
            if (node.align[column]) td.style.textAlign = node.align[column];
            cell.children.forEach((child) => render(td, child));
          });
        });
        break;
      }
      case "footnoteReference":
        write(element(parent, "sup"), source.slice(start, end), start, end, false);
        break;
      case "footnoteDefinition": {
        const footnote = element(parent, "aside");
        footnote.className = "markdown-footnote";
        element(footnote, "small").textContent = node.label || node.identifier;
        descend(footnote);
        break;
      }
      case "definition":
        break;
      default:
        if (children) descend(parent);
        else write(parent, source.slice(start, end), start, end, false);
    }
  }

  if (literal) write(target, source, 0, source.length, false);
  else tree.children.forEach((node) => render(target, node));
}

function* trackedText(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const offsets = sourceOffsets.get(node);
    if (offsets?.length) yield { node, offsets };
  }
}

export function selectionSource(element, range) {
  let start;
  let end;
  for (const { node, offsets } of trackedText(element)) {
    if (!range.intersectsNode(node)) continue;
    const first = range.startContainer === node ? range.startOffset : 0;
    const last = range.endContainer === node ? range.endOffset : node.length;
    if (first >= last) continue;
    start ??= offsets[first * 2];
    end = offsets[last * 2 - 1];
  }
  return end > start ? { start, end } : null;
}

export function sourceRange(element, start, end) {
  let first;
  let last;
  for (const { node, offsets } of trackedText(element)) {
    for (let index = 0; index < node.length; index += 1) {
      if (offsets[index * 2] >= end || offsets[index * 2 + 1] <= start) continue;
      first ??= [node, index];
      last = [node, index + 1];
    }
  }
  if (!first) return null;
  const range = document.createRange();
  range.setStart(...first);
  range.setEnd(...last);
  return range;
}
