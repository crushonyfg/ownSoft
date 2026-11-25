import { textEdits } from "./text-edits.mjs";

export function anchoredText(text, start, quote) {
  return { start, quote, prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(start + quote.length, start + quote.length + 80) };
}

export function resolveAnchor(text, anchor, { strict = false } = {}) {
  const quote = anchor.quote;
  if (!quote) return { ...anchor, lost: true, lostReason: "原文已删除" };
  if (!strict && !anchor.lost && text.slice(anchor.start, anchor.start + quote.length) === quote) {
    return { ...anchor, ...anchoredText(text, anchor.start, quote) };
  }
  const positions = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + Math.max(1, quote.length))) {
    let score = 0;
    const prefix = anchor.prefix || "", suffix = anchor.suffix || "";
    for (let i = 1; i <= prefix.length && at - i >= 0 && text[at - i] === prefix[prefix.length - i]; i++) score++;
    for (let i = 0; i < suffix.length && text[at + quote.length + i] === suffix[i]; i++) score++;
    positions.push({ start: at, score });
  }
  positions.sort((a, b) => b.score - a.score);
  const best = positions[0];
  const ambiguous = positions.length > 1 && (!best.score || best.score === positions[1].score);
  const insufficient = strict && (anchor.prefix || anchor.suffix) && best &&
    best.score < Math.min(12, (anchor.prefix?.length || 0) + (anchor.suffix?.length || 0));
  if (!best || ambiguous || insufficient) return { ...anchor, lost: true,
    lostReason: ambiguous ? "存在多处相同原文，请重新关联" : "原文已修改或删除，请重新关联" };
  const { lost, lostReason, ...rest } = anchor;
  return { ...rest, ...anchoredText(text, best.start, quote) };
}

export function moveAnchors(before, after, anchors) {
  if (before === after) return anchors;
  const edits = textEdits(before, after);
  return anchors.map((item) => {
    const anchor = { ...item, ...(!item.lost ? anchoredText(before, item.start, item.quote) : {}) };
    let shift = 0, overlap = false;
    for (const edit of edits) {
      if (edit.end <= item.start) shift += edit.text.length - (edit.end - edit.start);
      else if (edit.start < item.start + item.quote.length) overlap = true;
    }
    if (!overlap && !item.lost && after.slice(item.start + shift, item.start + shift + item.quote.length) === item.quote) {
      return { ...anchor, ...anchoredText(after, item.start + shift, item.quote) };
    }
    const repeated = before.indexOf(item.quote) !== before.lastIndexOf(item.quote);
    return resolveAnchor(after, anchor, { strict: repeated });
  });
}

export function toggleTextMark(text, marks, anchor, style) {
  if (!["highlight", "underline"].includes(style)) throw new Error("未知的标记类型。");
  if (!Number.isInteger(anchor?.start) || anchor.start < 0 || !anchor.quote ||
      text.slice(anchor.start, anchor.start + anchor.quote.length) !== anchor.quote) throw new Error("选区已改变，请重新选中文字。");
  const at = marks.findIndex((mark) => mark.style === style && mark.start === anchor.start && mark.quote === anchor.quote);
  if (at >= 0) marks.splice(at, 1);
  else marks.push({ ...anchor, ...anchoredText(text, anchor.start, anchor.quote), style });
}
