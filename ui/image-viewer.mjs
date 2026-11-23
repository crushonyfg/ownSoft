// One viewer for every picture in the app: zoom (wheel, buttons, double-click), pan (drag), and for
// image notes an editor that draws over the picture: dots, freehand, lines, arrows, boxes, ellipses
// and text, with select / move / delete and undo. Shapes are kept as data (in image pixels) so a
// picture can be edited again; saving also flattens them into a new PNG for the chat and models.
const svgNS = "http://www.w3.org/2000/svg";
const colors = ["#e5484d", "#f5a524", "#30a46c", "#0090ff", "#8e4ec6", "#111111", "#ffffff"];
const sizes = [{ label: "细", stroke: 2, text: 16 }, { label: "中", stroke: 4, text: 24 }, { label: "粗", stroke: 8, text: 36 }];
const tools = [
  ["select", "选择", "选中图形后可拖动，Delete 删除，双击文字可改"], ["pan", "抓手", "拖动画面（也可按住空格）"],
  ["dot", "点", "点一下放一个圆点"], ["pen", "画笔", "按住拖动自由画"], ["line", "直线", "拖出一条直线（按住 Shift 保持水平/垂直/45°）"],
  ["arrow", "箭头", "从起点拖到箭头所指的地方"], ["rect", "方框", "拖出一个方框"], ["ellipse", "椭圆", "拖出一个椭圆"],
  ["text", "文字", "点一下输入文字，Enter 完成，Shift+Enter 换行"]
];

function create(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}
function control(text, title, className = "") {
  const element = create("button", className, text);
  element.type = "button";
  if (title) element.title = title;
  return element;
}
const svg = (tag, attributes = {}) => {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
};

// ---- shapes: drawn the same way in the SVG overlay and on the export canvas -----------------------
function arrowHead(shape) {
  const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
  const length = Math.max(10, shape.width * 4);
  const spread = Math.PI / 7;
  return [[shape.x2, shape.y2],
    [shape.x2 - length * Math.cos(angle - spread), shape.y2 - length * Math.sin(angle - spread)],
    [shape.x2 - length * Math.cos(angle + spread), shape.y2 - length * Math.sin(angle + spread)]];
}

function shapeElement(shape, index) {
  const stroke = { stroke: shape.color, "stroke-width": shape.width, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
  let element;
  if (shape.type === "pen") {
    element = svg("path", { ...stroke, d: shape.points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ") });
  } else if (shape.type === "line") {
    element = svg("line", { ...stroke, x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 });
  } else if (shape.type === "arrow") {
    element = svg("g");
    const head = arrowHead(shape);
    element.append(svg("line", { ...stroke, x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 }),
      svg("polygon", { fill: shape.color, stroke: shape.color, "stroke-linejoin": "round", "stroke-width": 1, points: head.map((point) => point.join(",")).join(" ") }));
  } else if (shape.type === "rect") {
    element = svg("rect", { ...stroke, x: shape.x, y: shape.y, width: shape.w, height: shape.h });
  } else if (shape.type === "ellipse") {
    element = svg("ellipse", { ...stroke, cx: shape.x + shape.w / 2, cy: shape.y + shape.h / 2, rx: Math.abs(shape.w / 2), ry: Math.abs(shape.h / 2) });
  } else if (shape.type === "dot") {
    element = svg("circle", { fill: shape.color, cx: shape.x, cy: shape.y, r: shape.r });
  } else if (shape.type === "text") {
    element = svg("text", { x: shape.x, y: shape.y, fill: shape.color, "font-size": shape.size, "font-weight": 600,
      "font-family": "system-ui, 'Microsoft YaHei', sans-serif", "dominant-baseline": "hanging",
      stroke: shape.color === "#ffffff" ? "#000000" : "#ffffff", "stroke-width": Math.max(2, shape.size / 8), "paint-order": "stroke" });
    shape.text.split("\n").forEach((line, i) => {
      const span = svg("tspan", { x: shape.x, dy: i ? shape.size * 1.25 : 0 });
      span.textContent = line || " ";
      element.append(span);
    });
  }
  element.dataset.index = index;
  element.classList.add("image-shape");
  return element;
}

function drawShape(context, shape) {
  context.save();
  context.strokeStyle = context.fillStyle = shape.color;
  context.lineWidth = shape.width || 1;
  context.lineCap = context.lineJoin = "round";
  if (shape.type === "pen") {
    context.beginPath();
    shape.points.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.stroke();
  } else if (shape.type === "line" || shape.type === "arrow") {
    context.beginPath();
    context.moveTo(shape.x1, shape.y1);
    context.lineTo(shape.x2, shape.y2);
    context.stroke();
    if (shape.type === "arrow") {
      const head = arrowHead(shape);
      context.beginPath();
      context.moveTo(...head[0]);
      context.lineTo(...head[1]);
      context.lineTo(...head[2]);
      context.closePath();
      context.lineWidth = 1;
      context.fill();
      context.stroke();
    }
  } else if (shape.type === "rect") {
    context.strokeRect(shape.x, shape.y, shape.w, shape.h);
  } else if (shape.type === "ellipse") {
    context.beginPath();
    context.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2);
    context.stroke();
  } else if (shape.type === "dot") {
    context.beginPath();
    context.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
    context.fill();
  } else if (shape.type === "text") {
    context.font = `600 ${shape.size}px system-ui, "Microsoft YaHei", sans-serif`;
    context.textBaseline = "top";
    context.lineWidth = Math.max(2, shape.size / 8);
    context.strokeStyle = shape.color === "#ffffff" ? "#000000" : "#ffffff";
    shape.text.split("\n").forEach((line, i) => {
      const y = shape.y + i * shape.size * 1.25;
      context.strokeText(line, shape.x, y);
      context.fillText(line, shape.x, y);
    });
  }
  context.restore();
}

function moveShape(shape, dx, dy) {
  if (shape.type === "pen") shape.points = shape.points.map(([x, y]) => [x + dx, y + dy]);
  else if (shape.type === "line" || shape.type === "arrow") Object.assign(shape, { x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy });
  else Object.assign(shape, { x: shape.x + dx, y: shape.y + dy });
}

// A box drawn from either corner, as x/y/w/h with positive sizes.
const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
const round = (value) => Math.round(value * 10) / 10;

export function setupImageViewer({ notify = () => {} } = {}) {
  // ---- the overlay -------------------------------------------------------------------------------
  const overlay = create("div", "image-viewer");
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const bar = create("div", "image-viewer-bar");
  const title = create("strong", "image-viewer-title");
  const zoomOut = control("−", "缩小");
  const zoomLabel = control("100%", "原始大小（100%）", "image-viewer-zoom");
  const zoomIn = control("+", "放大");
  const fitButton = control("适应窗口", "整张图放进窗口");
  const editButton = control("编辑", "在图上画点、线、箭头、方框或写字", "primary");
  const restoreButton = control("恢复原图", "去掉所有标注，回到原来的图片");
  const externalButton = control("用系统查看器打开", "");
  const closeButton = control("×", "关闭（Esc）", "image-viewer-close");
  const spacer = create("span", "image-viewer-spacer");
  bar.append(title, spacer, zoomOut, zoomLabel, zoomIn, fitButton, editButton, restoreButton, externalButton, closeButton);

  const toolbar = create("div", "image-editor-bar");
  toolbar.hidden = true;
  const toolButtons = new Map(tools.map(([id, label, hint]) => {
    const button = control(label, hint, "image-tool");
    button.dataset.tool = id;
    return [id, button];
  }));
  const swatches = colors.map((color) => {
    const button = control("", color, "image-swatch");
    button.style.background = color;
    button.dataset.color = color;
    return button;
  });
  const sizeButtons = sizes.map((size, index) => {
    const button = control(size.label, `线宽和字号：${size.label}`, "image-size");
    button.dataset.size = index;
    return button;
  });
  const undoButton = control("撤销", "撤销（Ctrl+Z）");
  const redoButton = control("重做", "重做（Ctrl+Y）");
  const clearButton = control("清空标注", "去掉这张图上所有标注");
  const cancelButton = control("取消", "不保存，回到查看");
  const saveButton = control("保存", "保存成新的图片（原图保留，可恢复）", "primary");
  const group = (...items) => { const element = create("div", "image-editor-group"); element.append(...items); return element; };
  toolbar.append(group(...toolButtons.values()), group(...swatches), group(...sizeButtons),
    group(undoButton, redoButton, clearButton), create("span", "image-viewer-spacer"), group(cancelButton, saveButton));

  const stage = create("div", "image-stage");
  const canvas = create("div", "image-canvas");
  const picture = create("img", "image-picture");
  picture.draggable = false;
  const layer = svg("svg", { class: "image-layer" });
  canvas.append(picture, layer);
  stage.append(canvas);
  const hint = create("div", "image-viewer-hint");
  overlay.append(bar, toolbar, stage, hint);
  document.body.append(overlay);

  // ---- state -------------------------------------------------------------------------------------
  let options = null;
  let view = { scale: 1, x: 0, y: 0 };
  let natural = { width: 0, height: 0 };
  let editing = false;
  let shapes = [];
  let past = [];
  let future = [];
  let tool = "pen";
  let color = colors[0];
  let sizeIndex = 1;
  let selected = -1;
  let drawing = null;
  let spaceDown = false;
  let dirty = false;
  let textBox = null;

  const unit = () => Math.max(1, Math.max(natural.width, natural.height) / 1400);

  function apply() {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  }
  function fit() {
    const area = stage.getBoundingClientRect();
    if (!natural.width || !area.width) return;
    const scale = Math.min((area.width - 40) / natural.width, (area.height - 40) / natural.height, 1);
    view = { scale, x: (area.width - natural.width * scale) / 2, y: (area.height - natural.height * scale) / 2 };
    apply();
  }
  function zoomAt(factor, clientX, clientY) {
    const area = stage.getBoundingClientRect();
    const px = (clientX ?? area.left + area.width / 2) - area.left;
    const py = (clientY ?? area.top + area.height / 2) - area.top;
    const scale = Math.min(16, Math.max(0.05, view.scale * factor));
    view = { scale, x: px - (px - view.x) * (scale / view.scale), y: py - (py - view.y) * (scale / view.scale) };
    apply();
  }
  const actual = () => {
    const area = stage.getBoundingClientRect();
    view = { scale: 1, x: (area.width - natural.width) / 2, y: (area.height - natural.height) / 2 };
    apply();
  };
  // Pointer position in image pixels.
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: round((event.clientX - rect.left) / view.scale), y: round((event.clientY - rect.top) / view.scale) };
  }

  function paint() {
    layer.setAttribute("viewBox", `0 0 ${natural.width} ${natural.height}`);
    layer.setAttribute("width", natural.width);
    layer.setAttribute("height", natural.height);
    const elements = shapes.map((shape, index) => shapeElement(shape, index));
    if (drawing?.shape) elements.push(shapeElement(drawing.shape, -1));
    layer.replaceChildren(...elements);
    const chosen = selected >= 0 && layer.querySelector(`[data-index="${selected}"]`);
    if (chosen) {
      const bounds = chosen.getBBox();
      const pad = 6 * unit();
      layer.append(svg("rect", { class: "image-selection", x: bounds.x - pad, y: bounds.y - pad,
        width: bounds.width + pad * 2, height: bounds.height + pad * 2, "stroke-width": 1.5 * unit(), "stroke-dasharray": `${6 * unit()} ${4 * unit()}` }));
    }
    overlay.classList.toggle("is-editing", editing);
    overlay.dataset.tool = spaceDown ? "pan" : tool;
    for (const [id, button] of toolButtons) button.setAttribute("aria-pressed", String(id === tool));
    for (const swatch of swatches) swatch.setAttribute("aria-pressed", String(swatch.dataset.color === color));
    for (const button of sizeButtons) button.setAttribute("aria-pressed", String(Number(button.dataset.size) === sizeIndex));
    undoButton.disabled = !past.length;
    redoButton.disabled = !future.length;
    clearButton.disabled = !shapes.length;
    saveButton.disabled = !dirty;
  }

  function remember() {
    past.push(JSON.stringify(shapes));
    if (past.length > 200) past.shift();
    future = [];
    dirty = true;
  }
  function undo() {
    if (!past.length) return;
    future.push(JSON.stringify(shapes));
    shapes = JSON.parse(past.pop());
    selected = -1;
    dirty = true;
    paint();
  }
  function redo() {
    if (!future.length) return;
    past.push(JSON.stringify(shapes));
    shapes = JSON.parse(future.pop());
    selected = -1;
    dirty = true;
    paint();
  }

  // ---- text: a floating box over the picture, committed as a shape ---------------------------------
  function openText(at, existing = -1) {
    closeText(true);
    const shape = existing >= 0 ? shapes[existing] : null;
    const size = shape?.size || sizes[sizeIndex].text * unit();
    const input = create("textarea", "image-text-input");
    input.value = shape?.text || "";
    input.rows = Math.max(1, input.value.split("\n").length);
    const rect = canvas.getBoundingClientRect();
    const area = overlay.getBoundingClientRect();
    Object.assign(input.style, { left: `${rect.left - area.left + at.x * view.scale}px`, top: `${rect.top - area.top + at.y * view.scale}px`,
      fontSize: `${size * view.scale}px`, color: shape?.color || color });
    overlay.append(input);
    textBox = { input, at, existing, size, color: shape?.color || color };
    if (shape) { shapes = shapes.filter((_, i) => i !== existing); selected = -1; paint(); textBox.removed = shape; }
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); closeText(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeText(false); }
      input.rows = Math.max(1, input.value.split("\n").length);
    });
    input.addEventListener("blur", () => closeText(true));
    requestAnimationFrame(() => input.focus());
  }
  function closeText(keep) {
    if (!textBox) return;
    const { input, at, size, removed } = textBox;
    const text = input.value.replace(/\s+$/, "");
    textBox = null;
    input.remove();
    if (keep && text) {
      remember();
      if (removed) { past[past.length - 1] = JSON.stringify([...shapes, removed]); }
      shapes.push({ type: "text", x: at.x, y: at.y, text, color: removed?.color || color, size });
    } else if (removed) {
      shapes.push(removed);
    }
    paint();
  }

  // ---- pointer handling --------------------------------------------------------------------------
  let pan = null;
  stage.addEventListener("pointerdown", (event) => {
    if (event.button === 1 || !editing || spaceDown || tool === "pan" || event.button === 2) {
      if (event.button !== 0 && event.button !== 1) return;
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...view } };
      stage.setPointerCapture(event.pointerId);
      overlay.classList.add("is-panning");
      return;
    }
    if (event.button !== 0 || textBox) return;
    const at = point(event);
    const stroke = sizes[sizeIndex].stroke * unit();
    if (tool === "select") {
      const target = event.target.closest?.(".image-shape");
      selected = target ? Number(target.dataset.index) : -1;
      if (selected >= 0) {
        drawing = { kind: "move", from: at, start: JSON.stringify(shapes) };
        stage.setPointerCapture(event.pointerId);
      }
      paint();
      return;
    }
    if (tool === "text") {
      openText(at);
      return;
    }
    if (tool === "dot") {
      remember();
      shapes.push({ type: "dot", x: at.x, y: at.y, r: stroke * 1.6 + 2 * unit(), color });
      paint();
      return;
    }
    const shape = tool === "pen" ? { type: "pen", points: [[at.x, at.y]], color, width: stroke }
      : tool === "line" || tool === "arrow" ? { type: tool, x1: at.x, y1: at.y, x2: at.x, y2: at.y, color, width: stroke }
      : { type: tool, x: at.x, y: at.y, w: 0, h: 0, color, width: stroke };
    drawing = { kind: "draw", from: at, shape };
    stage.setPointerCapture(event.pointerId);
    paint();
  });
  stage.addEventListener("pointermove", (event) => {
    if (pan && pan.id === event.pointerId) {
      view = { ...pan.view, x: pan.view.x + event.clientX - pan.x, y: pan.view.y + event.clientY - pan.y };
      apply();
      return;
    }
    if (!drawing) return;
    const at = point(event);
    if (drawing.kind === "move") {
      const before = JSON.parse(drawing.start);
      shapes = before;
      moveShape(shapes[selected], at.x - drawing.from.x, at.y - drawing.from.y);
      drawing.moved = true;
    } else {
      const shape = drawing.shape;
      if (shape.type === "pen") shape.points.push([at.x, at.y]);
      else if (shape.type === "line" || shape.type === "arrow") {
        let { x, y } = at;
        if (event.shiftKey) {
          const angle = Math.round(Math.atan2(y - shape.y1, x - shape.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const length = Math.hypot(x - shape.x1, y - shape.y1);
          x = round(shape.x1 + length * Math.cos(angle));
          y = round(shape.y1 + length * Math.sin(angle));
        }
        Object.assign(shape, { x2: x, y2: y });
      } else Object.assign(shape, box(drawing.from, at));
    }
    paint();
  });
  const finish = (event) => {
    if (pan && pan.id === event.pointerId) {
      pan = null;
      overlay.classList.remove("is-panning");
      return;
    }
    if (!drawing) return;
    const done = drawing;
    drawing = null;
    if (done.kind === "move") {
      if (done.moved) {
        const moved = JSON.stringify(shapes);
        shapes = JSON.parse(done.start);
        remember();
        shapes = JSON.parse(moved);
      }
    } else {
      const shape = done.shape;
      const tiny = shape.type === "pen" ? shape.points.length < 2
        : shape.type === "line" || shape.type === "arrow" ? Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 3
        : shape.w < 3 && shape.h < 3;
      if (!tiny) {
        remember();
        shapes.push(shape);
      }
    }
    paint();
  };
  stage.addEventListener("pointerup", finish);
  stage.addEventListener("pointercancel", finish);
  stage.addEventListener("dblclick", (event) => {
    if (editing) {
      const target = event.target.closest?.(".image-shape");
      const index = target ? Number(target.dataset.index) : -1;
      if (index >= 0 && shapes[index]?.type === "text") openText({ x: shapes[index].x, y: shapes[index].y }, index);
      return;
    }
    if (Math.abs(view.scale - 1) < 0.01) fit();
    else zoomAt(1 / view.scale, event.clientX, event.clientY);
  });
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener("contextmenu", (event) => event.preventDefault());

  // ---- keys (while open, the viewer handles them before the page does) ---------------------------
  function onKey(event) {
    if (overlay.hidden || textBox) return;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "Escape") {
      event.preventDefault();
      if (editing) leaveEdit();
      else close();
    } else if (editing && mod && key === "z" && !event.shiftKey) undo();
    else if (editing && mod && (key === "y" || (key === "z" && event.shiftKey))) redo();
    else if (editing && (event.key === "Delete" || event.key === "Backspace") && selected >= 0) {
      remember();
      shapes = shapes.filter((_, i) => i !== selected);
      selected = -1;
      paint();
    } else if (event.key === " " && editing) {
      if (!spaceDown) { spaceDown = true; paint(); }
    } else if (!mod && (key === "+" || key === "=")) zoomAt(1.25);
    else if (!mod && key === "-") zoomAt(0.8);
    else if (!mod && key === "0") fit();
    else if (editing && !mod && !event.altKey) {
      const shortcut = { v: "select", h: "pan", d: "dot", p: "pen", l: "line", a: "arrow", r: "rect", o: "ellipse", t: "text" }[key];
      if (!shortcut) return;
      tool = shortcut;
      selected = -1;
      paint();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }
  function onKeyUp(event) {
    if (event.key === " " && spaceDown) { spaceDown = false; paint(); }
  }

  // ---- buttons -----------------------------------------------------------------------------------
  zoomIn.addEventListener("click", () => zoomAt(1.25));
  zoomOut.addEventListener("click", () => zoomAt(0.8));
  zoomLabel.addEventListener("click", actual);
  fitButton.addEventListener("click", fit);
  closeButton.addEventListener("click", () => close());
  externalButton.addEventListener("click", () => options?.onExternal?.());
  editButton.addEventListener("click", () => enterEdit().catch((error) => notify(error.message)));
  restoreButton.addEventListener("click", () => {
    if (!options?.onRestore) return;
    Promise.resolve(options.onRestore()).then(() => close()).catch((error) => notify(error.message));
  });
  for (const [id, button] of toolButtons) button.addEventListener("click", () => { closeText(true); tool = id; selected = -1; paint(); });
  for (const swatch of swatches) swatch.addEventListener("click", () => {
    color = swatch.dataset.color;
    if (selected >= 0 && shapes[selected]) { remember(); shapes[selected].color = color; }
    paint();
  });
  for (const button of sizeButtons) button.addEventListener("click", () => {
    sizeIndex = Number(button.dataset.size);
    const shape = shapes[selected];
    if (shape) {
      remember();
      const stroke = sizes[sizeIndex].stroke * unit();
      if (shape.type === "text") shape.size = sizes[sizeIndex].text * unit();
      else if (shape.type === "dot") shape.r = stroke * 1.6 + 2 * unit();
      else shape.width = stroke;
    }
    paint();
  });
  undoButton.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);
  clearButton.addEventListener("click", () => { remember(); shapes = []; selected = -1; paint(); });
  cancelButton.addEventListener("click", () => leaveEdit());
  saveButton.addEventListener("click", () => save().catch((error) => notify(error.message)));

  // ---- opening, editing, saving ------------------------------------------------------------------
  function load(src) {
    return new Promise((resolve, reject) => {
      picture.onload = () => {
        natural = { width: picture.naturalWidth, height: picture.naturalHeight };
        resolve();
      };
      picture.onerror = () => reject(new Error("图片无法载入，文件可能已不存在。"));
      picture.src = src;
    });
  }

  // options: { src, name, editable, edit: { src, shapes } (the original and its shapes, when edited
  //   before), onSave({ name, data }, { shapes, width, height }), onRestore(), onExternal() }
  async function open(next) {
    options = next;
    editing = false;
    shapes = [];
    past = [];
    future = [];
    selected = -1;
    dirty = false;
    title.textContent = next.name || "图片";
    editButton.hidden = !next.editable;
    restoreButton.hidden = !next.editable || !next.edit;
    externalButton.hidden = !next.onExternal;
    toolbar.hidden = true;
    overlay.hidden = false;
    hint.textContent = "滚轮缩放 · 拖动平移 · 双击切换 100% / 适应窗口 · Esc 关闭";
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    await load(next.src);
    paint();
    fit();
  }

  async function enterEdit() {
    if (!options?.editable) return;
    // Edit the original again, with the shapes already on it.
    if (options.edit?.src) await load(options.edit.src);
    shapes = JSON.parse(JSON.stringify(options.edit?.shapes || []));
    past = [];
    future = [];
    dirty = false;
    editing = true;
    tool = "pen";
    toolbar.hidden = false;
    editButton.hidden = restoreButton.hidden = true;
    hint.textContent = "快捷键：V 选择 · H 抓手（或按住空格）· D 点 · P 画笔 · L 直线 · A 箭头 · R 方框 · O 椭圆 · T 文字 · Ctrl+Z 撤销 · Delete 删除选中";
    paint();
    fit();
  }

  async function leaveEdit({ force = false } = {}) {
    closeText(false);
    if (dirty && !force && !window.confirm("放弃这次的标注？")) return false;
    editing = false;
    shapes = [];
    selected = -1;
    toolbar.hidden = true;
    editButton.hidden = !options?.editable;
    restoreButton.hidden = !options?.editable || !options?.edit;
    hint.textContent = "滚轮缩放 · 拖动平移 · 双击切换 100% / 适应窗口 · Esc 关闭";
    await load(options.src);
    paint();
    fit();
    return true;
  }

  async function save() {
    closeText(true);
    const output = document.createElement("canvas");
    output.width = natural.width;
    output.height = natural.height;
    const context = output.getContext("2d");
    context.drawImage(picture, 0, 0);
    for (const shape of shapes) drawShape(context, shape);
    const blob = await new Promise((resolve) => output.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("图片生成失败。");
    const base = String(options.edit?.name || options.name || "图片").replace(/\.(png|jpe?g|webp)$/i, "").replace(/（已标注）$/, "");
    saveButton.disabled = true;
    try {
      await options.onSave({ name: `${base}（已标注）.png`, data: new Uint8Array(await blob.arrayBuffer()) },
        { shapes, width: natural.width, height: natural.height });
    } catch (error) {
      saveButton.disabled = false;
      throw error;
    }
    dirty = false;
    close(true);
  }

  function close(force = false) {
    if (editing && dirty && !force && !window.confirm("放弃这次的标注？")) return;
    closeText(false);
    overlay.hidden = true;
    editing = false;
    picture.removeAttribute("src");
    layer.replaceChildren();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKeyUp, true);
    options = null;
  }

  return { open, close, isOpen: () => !overlay.hidden };
}
