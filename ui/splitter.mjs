// A drag handle between two panes. Dragging sets a CSS length on `target` (for example the width
// of the right column); the size is remembered on this computer. Double-click goes back to the default.
const read = (key) => {
  try { return localStorage.getItem(`ai-notebook:split:${key}`); } catch { return null; }
};
const write = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(`ai-notebook:split:${key}`);
    else localStorage.setItem(`ai-notebook:split:${key}`, value);
  } catch {}
};

/**
 * handle: the bar to drag; target: the element whose CSS property holds the size;
 * axis "x" (columns) or "y" (rows); fromEnd: the size is measured from the right/bottom edge;
 * min / keep: smallest size of the measured pane and of the pane on the other side (px).
 */
export function splitter(handle, { target, property, axis = "x", fromEnd = false, min = 200, keep = 240, key }) {
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
  handle.title = "拖动调整大小，双击恢复默认";
  const saved = key && read(key);
  if (saved) target.style.setProperty(property, saved);
  let drag = null;
  const measure = (event) => {
    const box = target.getBoundingClientRect();
    const total = axis === "x" ? box.width : box.height;
    const raw = axis === "x" ? (fromEnd ? box.right - event.clientX : event.clientX - box.left)
      : (fromEnd ? box.bottom - event.clientY : event.clientY - box.top);
    return `${Math.round(Math.max(min, Math.min(total - keep, raw)))}px`;
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add(axis === "x" ? "is-resizing-x" : "is-resizing-y");
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag !== event.pointerId) return;
    target.style.setProperty(property, measure(event));
  });
  const stop = (event) => {
    if (drag !== event.pointerId) return;
    drag = null;
    handle.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-x", "is-resizing-y");
    if (key) write(key, target.style.getPropertyValue(property));
    target.dispatchEvent(new Event("splitresize"));
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("lostpointercapture", stop);
  handle.addEventListener("dblclick", () => {
    target.style.removeProperty(property);
    if (key) write(key, null);
    target.dispatchEvent(new Event("splitresize"));
  });
}
