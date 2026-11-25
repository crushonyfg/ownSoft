// A document's conversation index. Selecting a row opens the one shared full chat component.
export function setupReviewHistory(api, { host, kind, current, open, notify, toggle, layout }) {
  let generation = 0, timer;
  if (toggle && layout) toggle.addEventListener("click", () => {
    layout.classList.toggle("history-hidden");
    toggle.setAttribute("aria-pressed", String(!layout.classList.contains("history-hidden")));
  });
  async function refresh(selected) {
    const id = current();
    if (!id) return host.replaceChildren();
    const ticket = ++generation;
    const items = await api.reviewHistory(kind, id);
    if (ticket !== generation || current() !== id) return;
    const fragment = document.createDocumentFragment();
    const heading = document.createElement("h3");
    heading.textContent = "会话历史";
    fragment.append(heading);
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "选区提问会自动保存在这里，无需先存为批注。";
      fragment.append(empty);
    }
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "document-history-row";
      row.dataset.chatId = item.id;
      if (item.id === selected || item.id === host.dataset.selected) row.setAttribute("aria-current", "page");
      const title = document.createElement("span"), detail = document.createElement("small");
      title.textContent = item.title;
      detail.textContent = `${item.kind.endsWith("-selection") ? "选区" : item.kind.endsWith("-comment") ? "批注" : "全文"} · ${item.running ? "正在生成" : `${item.replies} 条回答`}`;
      row.title = item.quote || item.title;
      row.append(title, detail);
      row.addEventListener("click", () => {
        if (current() !== id) { void refresh(); return; }
        host.dataset.selected = item.id;
        Promise.resolve(open(item)).then(() => refresh(item.id)).catch((error) => notify(error.message));
      });
      fragment.append(row);
    }
    host.replaceChildren(fragment);
  }
  api.onLibraryChanged(() => { clearTimeout(timer); timer = setTimeout(() => refresh().catch((error) => notify(error.message)), 180); });
  api.onMember?.(() => { clearTimeout(timer); timer = setTimeout(() => refresh().catch((error) => notify(error.message)), 180); });
  return { refresh, select: (id) => { host.dataset.selected = id; return refresh(id); } };
}
