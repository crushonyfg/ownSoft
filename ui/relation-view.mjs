// The relation view: everything that grew out of a chat — annotations and their follow-ups, side
// branches, private windows, PDF reviews — as a graph or an outline. It is only a container: each
// node points at a conversation, and picking one shows that conversation with the app's one chat
// component (embedChat), never a copy of its messages.
import { embedChat } from "./embedded-chat.mjs";

const kindLabels = {
  chat: "会话", note: "批注", branch: "分支", thread: "私聊", pdf: "PDF", "pdf-chat": "全文对话",
  "pdf-comment": "PDF 批注", md: "文档", "md-chat": "全文对话", "md-comment": "文档批注", todo: "待办"
};
const nodeWidth = 232;
const nodeHeight = 72;
const gapX = 56;
const gapY = 14;

function create(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

const keyOf = (node) => node.isRoot ? "root"
  : node.open ? JSON.stringify(node.open) : `${node.kind}:${node.hash || node.attachmentId || node.chatId || node.title}`;

function when(time) {
  if (!time) return "";
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ctx: { rootId(), notify(text), memberName(id), goTo(node), backToDocument(), openParent() }
export function setupRelationView(api, ctx) {
  const get = (id) => document.getElementById(id);
  const board = get("relation-board");
  const links = get("relation-links");
  const layer = get("relation-nodes");
  const outline = get("relation-outline");
  const detail = get("relation-detail");
  const collapsed = new Set();
  let mode = "graph";
  try { mode = localStorage.getItem("relation-mode") === "tree" ? "tree" : "graph"; } catch {}
  let tree = null;
  let selectedKey = null;
  let wanted = null;
  let token = 0;

  for (const control of document.querySelectorAll("[data-relation-mode]")) {
    control.addEventListener("click", () => {
      mode = control.dataset.relationMode;
      try { localStorage.setItem("relation-mode", mode); } catch {}
      paint();
    });
  }
  get("relation-close").addEventListener("click", () => select(null));
  get("relation-expand").addEventListener("click", () => {
    if (!tree) return;
    if (collapsed.size) collapsed.clear();
    else walk(tree, (node) => { if (!node.isRoot && node.children.length) collapsed.add(keyOf(node)); });
    paint();
  });

  function walk(node, visit, parent = null) {
    visit(node, parent);
    for (const child of node.children) walk(child, visit, node);
  }

  // Which nodes live in this chat (so "在原处打开" can go there) and which inside a child chat.
  function annotate(root) {
    root.isRoot = true;
    const mark = (node, home) => {
      for (const child of node.children) {
        child.home = home;
        mark(child, home && (child.kind === "pdf" || child.kind === "md"));
      }
    };
    mark(root, true);
  }

  async function render() {
    const mine = ++token;
    let next;
    try {
      next = await api.chatTree(ctx.rootId());
    } catch (error) {
      return ctx.notify(error.message);
    }
    if (mine !== token) return;
    annotate(next);
    tree = next;
    if (wanted) {
      walk(tree, (node) => {
        if (node.open?.kind === wanted.kind && node.open.itemId === wanted.itemId) selectedKey = keyOf(node);
      });
      wanted = null;
    }
    paint();
    const node = find(selectedKey);
    if (node) showDetail(node);
    else if (selectedKey) select(null);
  }

  function find(key) {
    let found = null;
    if (tree && key) walk(tree, (node) => { if (keyOf(node) === key) found = node; });
    return found;
  }

  function counts() {
    const total = {};
    walk(tree, (node) => { if (!node.isRoot) total[node.kind] = (total[node.kind] || 0) + 1; });
    const parts = [["note", "条批注"], ["branch", "条分支"], ["thread", "个私聊"], ["pdf", "份 PDF"],
      ["pdf-comment", "条 PDF 批注"], ["md-comment", "条文档批注"]];
    const text = parts.filter(([kind]) => total[kind]).map(([kind, unit]) => `${total[kind]} ${unit}`).join(" · ");
    return text || "还没有批注、分支或私聊。在正文里选中文字就可以开始。";
  }

  function card(node) {
    const element = create("div", `relation-node is-${node.kind}${node.isRoot ? " is-root" : ""}`);
    element.dataset.key = keyOf(node);
    const main = create("button", "relation-node-main");
    main.type = "button";
    main.setAttribute("aria-pressed", String(keyOf(node) === selectedKey));
    const kind = create("span", "relation-kind", kindLabels[node.kind] || node.kind);
    const title = node.kind === "thread" ? `私聊 · ${ctx.memberName(node.memberId) || "成员"}` : node.title;
    const meta = [];
    if (node.page) meta.push(`第 ${node.page} 页`);
    if (node.kind === "pdf" || node.kind === "md") meta.push(node.hash === null ? "还没有审阅" : `${node.comments || 0} 条批注`);
    else if (node.turns) meta.push(`${node.turns} 轮`);
    else if (node.open) meta.push(node.kind === "note" || node.kind.endsWith("-comment") ? "还没有追问" : "还没有对话");
    if (node.updated && (node.turns || node.isRoot)) meta.push(when(node.updated));
    main.title = [title, node.quote && `「${node.quote}」`, node.text].filter(Boolean).join("\n");
    main.append(kind, create("strong", "", title), create("small", "", meta.join(" · ")));
    main.addEventListener("click", () => select(keyOf(node)));
    element.append(main);
    if (node.children.length && !node.isRoot) {
      const shut = collapsed.has(keyOf(node));
      const toggle = create("button", "relation-toggle", `${shut ? "▸" : "▾"} ${node.children.length}`);
      toggle.type = "button";
      toggle.title = shut ? "展开" : "收起";
      toggle.setAttribute("aria-expanded", String(!shut));
      toggle.addEventListener("click", () => {
        if (shut) collapsed.delete(keyOf(node));
        else collapsed.add(keyOf(node));
        paint();
      });
      element.append(toggle);
    }
    return element;
  }

  function paint() {
    for (const control of document.querySelectorAll("[data-relation-mode]")) {
      control.setAttribute("aria-pressed", String(control.dataset.relationMode === mode));
    }
    if (!tree) return;
    get("relation-count").textContent = counts();
    get("relation-expand").textContent = collapsed.size ? "全部展开" : "全部收起";
    board.hidden = mode !== "graph";
    outline.hidden = mode !== "tree";
    if (mode === "graph") paintGraph();
    else paintOutline();
  }

  function paintGraph() {
    const placed = [];
    let next = 20;
    const place = (node, depth) => {
      const open = node.children.length && (node.isRoot || !collapsed.has(keyOf(node)));
      const children = open ? node.children.map((child) => place(child, depth + 1)) : [];
      const y = children.length ? (children[0].y + children.at(-1).y) / 2 : (next += nodeHeight + gapY) - nodeHeight - gapY;
      const spot = { node, x: 20 + depth * (nodeWidth + gapX), y, children };
      placed.push(spot);
      return spot;
    };
    place(tree, 0);
    const edges = [];
    layer.replaceChildren(...placed.map((spot) => {
      const element = card(spot.node);
      element.style.left = `${spot.x}px`;
      element.style.top = `${spot.y}px`;
      for (const child of spot.children) {
        const x1 = spot.x + nodeWidth;
        const y1 = spot.y + nodeHeight / 2;
        const x2 = child.x;
        const y2 = child.y + nodeHeight / 2;
        const middle = (x1 + x2) / 2;
        const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
        edge.setAttribute("d", `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`);
        edge.setAttribute("class", `is-${child.node.kind}`);
        edges.push(edge);
      }
      return element;
    }));
    links.replaceChildren(...edges);
    board.style.width = `${Math.max(...placed.map((spot) => spot.x)) + nodeWidth + 24}px`;
    board.style.height = `${Math.max(...placed.map((spot) => spot.y)) + nodeHeight + 24}px`;
  }

  function paintOutline() {
    const list = (nodes) => {
      const items = create("ul", "relation-outline-list");
      for (const node of nodes) {
        const item = create("li");
        item.append(card(node));
        if (node.children.length && (node.isRoot || !collapsed.has(keyOf(node)))) item.append(list(node.children));
        items.append(item);
      }
      return items;
    };
    outline.replaceChildren(list([tree]));
  }

  function select(key) {
    selectedKey = key;
    for (const main of document.querySelectorAll(".relation-node")) {
      main.querySelector(".relation-node-main").setAttribute("aria-pressed", String(main.dataset.key === key));
    }
    const node = find(key);
    if (!node) {
      detail.hidden = true;
      get("relation-chat").replaceChildren();
      delete get("relation-chat").dataset.key;
      return;
    }
    if (node.isRoot && !node.parent) {
      selectedKey = null;
      detail.hidden = true;
      return ctx.backToDocument();
    }
    showDetail(node);
  }

  function showDetail(node) {
    detail.hidden = false;
    const title = node.kind === "thread" ? `私聊 · ${ctx.memberName(node.memberId) || "成员"}` : node.title;
    get("relation-kind").textContent = kindLabels[node.kind] || "";
    get("relation-title").textContent = title;
    const quote = get("relation-quote");
    quote.hidden = !node.quote && !node.text;
    quote.textContent = [node.quote && `「${node.quote}」`, node.text].filter(Boolean).join("  ");
    const actions = get("relation-actions");
    actions.replaceChildren();
    const action = (text, run, primary = false) => {
      const control = create("button", primary ? "primary" : "", text);
      control.type = "button";
      control.addEventListener("click", () => Promise.resolve(run()).catch((error) => ctx.notify(error.message)));
      actions.append(control);
    };
    const box = get("relation-chat");
    if (node.isRoot) {
      action("打开来源会话", () => ctx.openParent(), true);
      box.replaceChildren(create("p", "relation-hint", "这是从别处派生出的会话。左边是它自己派生出的批注、分支和私聊。"));
      delete box.dataset.key;
      return;
    }
    if (node.kind === "pdf" || node.kind === "md") {
      if (node.hash || node.mdId) action("打开审阅", () => ctx.goTo(node), true);
      box.replaceChildren(create("p", "relation-hint", node.hash === null
        ? "这份 PDF 还没有审阅记录。打开审阅后，批注和全文对话会出现在这里。"
        : "点下面的「全文对话」或某条批注，就能在这里看到那段会话。"));
      delete box.dataset.key;
      return;
    }
    if (node.home) action("在原处打开", () => ctx.goTo(node));
    action("完整会话 ↗", () => api.openChildChat(node.open));
    const key = keyOf(node);
    if (box.dataset.key === key && box.querySelector("iframe")) return;
    box.dataset.key = key;
    const show = (id) => { if (box.dataset.key === key) embedChat(box, id, { label: title }); };
    if (node.chatId) show(node.chatId);
    else api.childChatId(node.open).then(show).catch((error) => ctx.notify(error.message));
  }

  return {
    render,
    // Picks a node once the tree is in, e.g. the branch just made from a selection.
    select(match) {
      wanted = match;
      if (tree) render();
    },
    reset() {
      tree = null;
      selectedKey = null;
      collapsed.clear();
      select(null);
    }
  };
}
