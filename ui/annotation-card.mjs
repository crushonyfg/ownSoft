// Presentation only. Conversations always belong to embedChat/the full notebook page.
const expanded = new Set();
export function annotationCard(card, { key, text, open }) {
  const controls = document.createElement("div");
  controls.className = "review-card-controls";
  const toggle = document.createElement("button");
  toggle.type = "button";
  const enlarge = document.createElement("button");
  enlarge.type = "button";
  enlarge.className = "review-enlarge";
  enlarge.textContent = "放大 ↗";
  enlarge.title = "在完整会话中查看批注并继续追问";
  enlarge.addEventListener("click", open);
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "review-card-preview";
  preview.textContent = text.replace(/\s+/g, " ").slice(0, 160);
  preview.title = "展开批注";
  const paint = () => {
    const closed = !expanded.has(key);
    card.classList.toggle("is-collapsed", closed);
    toggle.textContent = closed ? "展开" : "收起";
    toggle.setAttribute("aria-expanded", String(!closed));
    preview.hidden = !closed;
  };
  const flip = () => { expanded.has(key) ? expanded.delete(key) : expanded.add(key); paint(); };
  toggle.addEventListener("click", flip);
  preview.addEventListener("click", flip);
  controls.append(toggle, enlarge);
  card.append(controls, preview);
  paint();
}
