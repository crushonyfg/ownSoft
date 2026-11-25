const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const views = new Map();

export function updateThinking(list, step) {
  if (!step?.id || typeof step.text !== "string") return;
  const previous = list.find((item) => item.id === step.id);
  if (previous) previous.text = step.text;
  else list.push({ id: step.id, text: step.text, kind: step.kind });
}

// The same process view is used in main chats, branches and embedded conversations.
export function workProgress(items = [], thinking = [], { running = false, key } = {}) {
  if (!items.length && !thinking.length) return null;
  const previous = key ? views.get(key) : null;
  const details = make("details", "work-progress");
  details.open = previous && previous.running === running ? previous.node.open : running;
  details.dataset.finalShown = running ? "0" : "1";
  details.append(make("summary", "", `${running ? "正在处理" : "处理过程"} · ${thinking.length} 条进度 · ${items.length} 次工具调用`));
  const steps = make("div", "work-steps");
  for (const step of thinking) steps.append(make("div", "work-step", step.text));
  if (thinking.length) details.append(steps);
  if (items.length) {
    const tools = make("details", "tool-details");
    tools.open = previous?.node.querySelector(".tool-details")?.open || false;
    tools.append(make("summary", "", `工具调用 · ${items.length} 项`));
    const list = make("div", "tool-list");
    for (const item of items) {
      const row = make("div", "tool-item");
      row.append(make("span", `tool-status is-${item.status || "done"}`,
        item.status === "running" ? "◌" : item.status === "failed" ? "!" : "✓"),
      make("strong", "", item.title || "工具调用"));
      if (item.detail) row.append(make("span", "tool-detail", item.detail));
      if (item.result) {
        const result = make("details", "tool-result");
        const body = make("pre");
        result.append(make("summary", "", "工具返回"), body);
        result.addEventListener("toggle", () => { body.textContent = result.open ? item.result : ""; });
        row.append(result);
      }
      list.append(row);
    }
    tools.append(list);
    details.append(tools);
  }
  if (key) {
    views.delete(key);
    views.set(key, { node: details, running });
    if (views.size > 40) views.delete(views.keys().next().value);
  }
  return details;
}

export function collapseWorkProgress(root) {
  const details = root?.querySelector(".work-progress");
  if (details && details.dataset.finalShown !== "1") {
    details.open = false;
    details.dataset.finalShown = "1";
  }
}
