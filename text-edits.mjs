// Conservative line diff, refined to character boundaries. A large rewrite falls back to one
// edit rather than allocating an unbounded diff matrix in the editor.
export function textEdits(before, after) {
  if (before === after) return [];
  const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const a = lines(before), b = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  let position = a.slice(0, prefix).join("").length;
  const refine = (start, end, text) => {
    const old = before.slice(start, end);
    let p = 0, s = 0;
    while (p < Math.min(old.length, text.length) && old[p] === text[p]) p++;
    while (s < Math.min(old.length, text.length) - p && old[old.length - s - 1] === text[text.length - s - 1]) s++;
    return { start: start + p, end: end - s, text: text.slice(p, text.length - s) };
  };
  if (left.length * right.length > 2_000_000) {
    return [refine(position, position + left.join("").length, right.join(""))];
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const edits = [];
  let i = 0, j = 0, start = null, added = "";
  const flush = () => { if (start !== null) edits.push(refine(start, position, added)); start = null; added = ""; };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      flush(); position += left[i++].length; j++;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      start ??= position; added += right[j++];
    } else { start ??= position; position += left[i++].length; }
  }
  flush();
  return edits;
}

export function mergeText(base, local, remote) {
  if (local === remote || remote === base) return { clean: true, text: local };
  if (local === base) return { clean: true, text: remote };
  const edits = textEdits(base, local), incoming = textEdits(base, remote);
  const word = (position) => {
    if (!base[position] || /\s/.test(base[position])) return null;
    let start = position, end = position;
    while (start > 0 && !/\s/.test(base[start - 1])) start--;
    while (end < base.length && !/\s/.test(base[end])) end++;
    return { start, end };
  };
  for (const change of incoming) {
    if (edits.some((edit) => edit.start === change.start && edit.end === change.end && edit.text === change.text)) continue;
    const conflict = edits.some((edit) => {
      const a = word(edit.start), b = word(change.start);
      // Two prefix/identifier edits can refine to adjacent character insertions. Treat edits
      // inside the same original word as a conflict rather than silently producing a new word.
      return (a && b && a.start === b.start) || edit.start === change.start ||
      (edit.start < change.end && change.start < edit.end) ||
      (edit.start === edit.end && change.start < edit.start && edit.start < change.end) ||
      (change.start === change.end && edit.start < change.start && change.start < edit.end);
    });
    if (conflict) return { clean: false, text: local };
    edits.push(change);
  }
  let text = base;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { clean: true, text };
}
