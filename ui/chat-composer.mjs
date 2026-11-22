// The question box used everywhere in the app: the main group chat, annotation follow-ups,
// PDF selection and whole-document conversations, and side conversations with one member.
// Every box shows the members as @ chips, autocompletes @names, takes attachments (file picker,
// drag and drop, Ctrl+V) and sends with the button or Ctrl+Enter.
import { pixelAvatar } from "./pixel-avatars.mjs";

const create = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const button = (text, className = "") => {
  const control = create("button", className, text);
  control.type = "button";
  return control;
};

export const providerLabel = (provider) => ({ claude: "Claude", gemini: "Gemini" })[provider] || "GPT";
export const mentionPattern = /@([\p{L}\p{N}_-]{1,24})/gu;
const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"];

// Members named with @ in a question, in the order they appear.
export function mentionedMembers(text, list) {
  const found = [];
  const unknown = [];
  for (const [, name] of text.matchAll(mentionPattern)) {
    const member = list.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (member && !found.includes(member)) found.push(member);
    else if (!member && !unknown.includes(name)) unknown.push(name);
  }
  return { found, unknown };
}

// Who will answer, in words: "将由 a → b 依次回答" or the default member.
export function mentionHint(text, list, fallback) {
  // A mention still being typed at the end is not flagged as unknown yet.
  const { found } = mentionedMembers(text, list);
  const { unknown } = mentionedMembers(text.replace(/@[\p{L}\p{N}_-]*$/u, ""), list);
  if (!fallback) return "";
  return (found.length > 1 ? `将由 ${found.map((item) => item.name).join(" → ")} 依次回答，后面的人能看到前面的回答`
    : found.length ? `将由 ${found[0].name} 回答` : `没有 @ 时由 ${fallback.name} 回答`) +
    (unknown.length ? ` · ${unknown.map((name) => `@${name}`).join("、")} 不是成员` : "");
}

// The "@abc" being typed right before the caret, if any.
function mentionQuery(input) {
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|[^\w@])@([\p{L}\p{N}_-]*)$/u.exec(before);
  return match ? { start: before.length - match[2].length - 1, text: match[2] } : null;
}

export function insertMention(input, name) {
  const query = mentionQuery(input);
  const start = query ? query.start : input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const spacer = before && !/\s$/.test(before) ? " " : "";
  input.value = `${before}${spacer}@${name} ${input.value.slice(end).replace(/^\s+/, "")}`;
  const caret = before.length + spacer.length + name.length + 2;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// @ autocomplete for a textarea inside a form: a small list of matching members above the box.
export function mentionAutocomplete(input, { members, describe = () => "" }) {
  let open = null;
  const menu = create("div", "mention-menu");
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "选择成员");
  menu.hidden = true;
  const close = () => {
    open = null;
    menu.hidden = true;
  };
  const update = () => {
    const query = mentionQuery(input);
    const options = query ? members().filter((item) => item.name.toLowerCase().startsWith(query.text.toLowerCase())) : [];
    if (!query || !options.length) return close();
    open = { options, index: Math.min(open?.index ?? 0, options.length - 1) };
    menu.replaceChildren(...options.map((member, index) => {
      const item = button("", "mention-option");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === open.index));
      item.append(pixelAvatar(member.avatar, "idle", ""), create("strong", "", member.name),
        create("span", "", describe(member)));
      item.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        close();
        insertMention(input, member.name);
      });
      return item;
    }));
    const form = input.closest("form") || input.parentElement;
    if (menu.parentElement !== form) form.append(menu);
    menu.style.left = `${input.offsetLeft}px`;
    menu.style.bottom = `${form.offsetHeight - input.offsetTop + 4}px`;
    menu.hidden = false;
  };
  input.addEventListener("input", update);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (event) => {
    if (!open || event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open.index = (open.index + (event.key === "ArrowDown" ? 1 : -1) + open.options.length) % open.options.length;
      update();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const member = open.options[open.index];
      close();
      insertMention(input, member.name);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });
  return { close, isOpen: () => Boolean(open) };
}

// The row of member chips above a question box; clicking one @-mentions that member.
export function memberChips({ members, defaultMember, describe = () => "", onPick, manage }) {
  const bar = create("div", "mention-bar");
  bar.setAttribute("aria-label", "点名字 @ 成员");
  const fallback = defaultMember?.();
  const list = members();
  bar.append(create("span", "mention-label", "@"), ...list.map((member) => {
    const chip = button("", "mention-chip");
    chip.title = `@${member.name}${describe(member) ? ` · ${describe(member)}` : ""}`;
    chip.append(pixelAvatar(member.avatar, "idle", ""), create("span", "", member.name));
    if (member.id === fallback?.id) chip.classList.add("is-default");
    chip.addEventListener("click", () => onPick(member));
    return chip;
  }));
  if (manage) bar.append(manage);
  return bar;
}

const isImage = (ref) => imageExtensions.includes(ref.extension);

function fileChip(ref, onRemove, busy) {
  const chip = create("span", isImage(ref) ? "attachment-chip has-thumb" : "attachment-chip");
  if (isImage(ref)) {
    const picture = create("img", "draft-thumb");
    picture.src = `notebook://app/note-image/${ref.id}`;
    picture.alt = "";
    chip.append(picture);
  }
  const name = create("span", "", ref.name);
  name.title = ref.name;
  const remove = button("×", "remove-file");
  remove.setAttribute("aria-label", `移除附件 ${ref.name}`);
  remove.disabled = busy;
  remove.addEventListener("click", () => onRemove(ref));
  chip.append(name, remove);
  return chip;
}

/**
 * One question box.
 *  members(): who can be @-mentioned (one member means a one-to-one conversation, no @ needed)
 *  defaultMember(): who answers when nobody is mentioned
 *  submit({ question, members, files }): send; the box clears when it resolves
 *  attachments: { stage(files, room), remove(id) } to allow files, or null
 *  draft: { get(), set(text) } to keep an unsent question across re-renders
 */
export function createComposer({
  label, placeholder = "输入问题", members, defaultMember, describe = () => "", submit, attachments = null,
  draft, notify = () => {}, tools = [], compact = false, maxFiles = 6, sendLabel = "发送", multi = true,
  parallel = false
}) {
  const form = create("form", `composer chat-composer${compact ? " is-compact" : ""}`);
  const heading = create("div", "composer-label");
  const chipSlot = create("div");
  const chips = create("div", "attachments");
  chips.hidden = true;
  const input = create("textarea");
  input.rows = 2;
  input.maxLength = 10_000;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", typeof label === "function" ? label() : label || placeholder);
  input.value = draft?.get() || "";
  const send = button(sendLabel, "primary");
  send.type = "submit";
  const row = create("div", "composer-row");
  row.append(input, send);
  const fileTools = create("div", "file-tools");
  const hint = create("span", "mention-hint");
  hint.setAttribute("aria-live", "polite");
  let picker;
  let addFiles;
  if (attachments) {
    picker = create("input");
    picker.type = "file";
    picker.accept = ".pdf,.png,.jpg,.jpeg,.webp";
    picker.multiple = true;
    picker.hidden = true;
    addFiles = button("＋ 附件");
    addFiles.title = "PDF、PNG、JPG、WebP；也可拖入或 Ctrl+V 粘贴截图";
    fileTools.append(picker, addFiles);
  }
  fileTools.append(hint, ...tools);
  form.append(heading, chipSlot, chips, row, fileTools);

  let files = [];
  // Questions still being answered. A parallel box (the group chat) takes the next question at once.
  let busy = 0;
  let staging = false;
  const autocomplete = mentionAutocomplete(input, { members, describe });

  const single = () => members().length <= 1 || !multi;
  function paint() {
    const fallback = defaultMember();
    heading.textContent = typeof label === "function" ? label() : label || "";
    heading.hidden = !heading.textContent;
    chipSlot.replaceChildren(single() ? create("span") : memberChips({
      members, defaultMember, describe, onPick: (member) => insertMention(input, member.name)
    }));
    chipSlot.hidden = single();
    hint.textContent = single() ? (fallback ? `由 ${fallback.name} 回答 · Ctrl+Enter 发送` : "")
      : `${mentionHint(input.value, members(), fallback)} · Ctrl+Enter 发送`;
    chips.hidden = !files.length;
    chips.replaceChildren(...files.map((ref) => fileChip(ref, removeFile, Boolean(busy) && !parallel)));
    // The next question can be drafted while an answer is still coming; only sending waits.
    const waiting = busy && !parallel;
    send.disabled = waiting || staging || (!input.value.trim() && !files.length);
    if (addFiles) addFiles.disabled = waiting || staging || files.length >= maxFiles;
  }

  async function removeFile(ref) {
    try {
      await attachments.remove(ref.id);
      files = files.filter((item) => item.id !== ref.id);
    } catch (error) {
      notify(error.message);
    }
    paint();
  }

  async function stage(selected) {
    if (!attachments || !selected.length || (busy && !parallel) || staging) return;
    const room = maxFiles - files.length;
    if (room < 1) return notify(`每条消息最多添加 ${maxFiles} 个附件。`);
    staging = true;
    paint();
    try {
      const { items, errors } = await attachments.stage(selected, room);
      files = [...files, ...items];
      if (errors.length) notify(errors.join(" "));
    } catch (error) {
      notify(error.message);
    } finally {
      staging = false;
      paint();
    }
  }

  // Who answers this question: the @-mentioned members in order, else the default member.
  function speakers(question) {
    if (single()) return [defaultMember()].filter(Boolean);
    const { found } = mentionedMembers(question, members());
    return found.length ? found.slice(0, 8) : [defaultMember()].filter(Boolean);
  }

  async function run() {
    const question = input.value.trim();
    if ((!question && !files.length) || (busy && !parallel) || staging) return;
    const who = speakers(question);
    if (!who.length) return notify("还没有成员可以回答，请先在「本聊天成员」里添加。");
    busy += 1;
    autocomplete.close();
    const sent = [...files];
    const typed = input.value;
    // A parallel box empties right away so the next question can be written; it comes back on failure.
    if (parallel) {
      files = [];
      input.value = "";
      draft?.set("");
    }
    paint();
    try {
      await submit({ question, members: who, files: sent });
      if (!parallel) {
        files = [];
        if (input.value.trim() === question) {
          input.value = "";
          draft?.set("");
        }
      }
    } catch (error) {
      notify(error.message);
      if (parallel && !input.value.trim()) {
        input.value = typed;
        draft?.set(typed);
        files = [...sent, ...files];
      }
    } finally {
      busy -= 1;
      paint();
    }
  }

  input.addEventListener("input", () => {
    draft?.set(input.value);
    paint();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing && !autocomplete.isOpen()) {
      event.preventDefault();
      void run();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run();
  });
  if (attachments) {
    addFiles.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
      const selected = [...picker.files];
      picker.value = "";
      void stage(selected);
    });
    form.addEventListener("dragover", (event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      form.classList.add("dragging");
    });
    form.addEventListener("dragleave", (event) => {
      if (!form.contains(event.relatedTarget)) form.classList.remove("dragging");
    });
    form.addEventListener("drop", (event) => {
      form.classList.remove("dragging");
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void stage([...event.dataTransfer.files]);
    });
    input.addEventListener("paste", (event) => {
      const pasted = [...(event.clipboardData?.files || [])];
      if (!pasted.length) return;
      event.preventDefault();
      event.stopPropagation();
      void stage(pasted);
    });
  }
  paint();
  return {
    element: form,
    input,
    focus: () => input.focus(),
    refresh: paint,
    get busy() { return busy; },
    // Files still waiting in the box when it is thrown away go back to the attachment store.
    discard: () => Promise.allSettled(files.map((ref) => attachments?.remove(ref.id)))
  };
}
