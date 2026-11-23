// A shared slash picker for note blocks and Markdown source. The stored link is ordinary Markdown,
// so edits, previews and model-side reading all see the same source text.
export function attachSlashLinks(input, host, loadItems, onError = () => {}) {
  const menu = document.createElement("div");
  menu.className = "slash-link-menu";
  menu.hidden = true;
  host.append(menu);
  let items;
  const refresh = async () => {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(?:^|\s)\/([^/\n]{0,80})$/u);
    if (!match) { menu.hidden = true; return; }
    items ??= Promise.resolve().then(loadItems);
    const query = match[1].toLocaleLowerCase();
    const matches = (await items).filter((item) => item.title.toLocaleLowerCase().includes(query)).slice(0, 9);
    if (!input.isConnected) return;
    menu.replaceChildren(...matches.map((item) => {
      const option = document.createElement("button");
      option.type = "button";
      option.textContent = `${item.kind === "md" ? "MD" : "会话"} · ${item.title}`;
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        const caret = input.selectionStart;
        const latest = input.value.slice(0, caret).match(/(?:^|\s)\/([^/\n]{0,80})$/u);
        if (!latest) return;
        const title = item.title.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
        input.setRangeText(`[${title}](ownsoft://${item.kind}/${item.id})`,
          caret - latest[1].length - 1, caret, "end");
        menu.hidden = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
      return option;
    }));
    menu.hidden = !matches.length;
  };
  input.addEventListener("input", () => { void refresh().catch(onError); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) { menu.hidden = true; event.stopPropagation(); }
    if (event.key === "Enter" && !menu.hidden) { event.preventDefault(); menu.querySelector("button")?.click(); }
  });
  return () => menu.remove();
}
