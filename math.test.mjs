import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, splitMarkdown } from "./markdown.mjs";

// Every formula node with its value, display flag and the exact source it covers.
function formulas(source) {
  const found = [];
  const walk = (node) => {
    if (node.type === "inlineMath" || node.type === "math") {
      found.push([node.value, Boolean(node.display), source.slice(node.position.start.offset, node.position.end.offset)]);
    }
    (node.children || []).forEach(walk);
  };
  walk(parseMarkdown(source));
  return found;
}

test("backslash delimiters become formulas instead of escaped brackets", () => {
  assert.deepEqual(formulas(String.raw`设 \(a_1 + b_2\) 且 *c* 成立`), [["a_1 + b_2", false, String.raw`\(a_1 + b_2\)`]]);
  assert.deepEqual(formulas(String.raw`公式 \[x^2 = \frac{a}{b}\] 结束`),
    [[String.raw`x^2 = \frac{a}{b}`, true, String.raw`\[x^2 = \frac{a}{b}\]`]]);
  assert.deepEqual(formulas(String.raw`\(\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}\) 与 \(\{x \mid x>0\}\)`).map(([value]) => value),
    [String.raw`\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`, String.raw`\{x \mid x>0\}`]);
});

test("display blocks keep lines that would otherwise start lists or headings", () => {
  const block = "\\[\n\\begin{aligned}\na &= b \\\\\n- c &= d\n# e &= f\n\\end{aligned}\n\\]\n\n下一段";
  const tree = parseMarkdown(block);
  assert.deepEqual(tree.children.map((node) => node.type), ["math", "paragraph"]);
  assert.match(tree.children[0].value, /- c &= d\n# e &= f/);
  assert.deepEqual(parseMarkdown("$$\nE = mc^2\n$$").children.map((node) => [node.type, node.value]), [["math", "E = mc^2"]]);
  assert.deepEqual(splitMarkdown("前文\n\n\\[\na\n\nb\n\\]\n\n后文").length, 3);
});

test("dollar signs used for money stay text", () => {
  assert.deepEqual(formulas("收于 $608.45，最低 $606.23，区间 $600-$700"), []);
  assert.deepEqual(formulas("数学 $a_1 * b_2 * c$ 和 \\$5 与 $10"), [["a_1 * b_2 * c", false, "$a_1 * b_2 * c$"]]);
  assert.deepEqual(formulas("欧拉 $e^{i\\pi}+1=0$，积分 $$\\int_0^1 x\\,dx$$").map(([value, display]) => [value, display]),
    [["e^{i\\pi}+1=0", false], ["\\int_0^1 x\\,dx", true]]);
});

test("code stays code, and an unclosed delimiter falls back to text", () => {
  assert.deepEqual(formulas("代码 `\\(x\\)` 和\n\n```\n$$\nx\n$$\n```"), []);
  assert.deepEqual(formulas("未闭合 \\(x 继续"), []);
  assert.deepEqual(formulas("| a |\n|---|\n| \\(x^2\\) |").map(([value]) => value), ["x^2"]);
});
