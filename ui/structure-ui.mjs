// Moving things around: drag any message (or a margin annotation) to a new place, in this chat or
// in another window's chat; undo recent structural edits (Ctrl+Z outside text fields); and a small
// command line (Ctrl+K) for jumping, moving and removing by message ID. All edits go through the
// store's structural operations (store.structure), which keep the undo journal.
const messageType = "application/x-ownsoft-message";
const noteType = "application/x-ownsoft-note";

function create(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

const editable = (target) => target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");

// ctx: { chatId(), notify(text), refresh(result), dropSpot(target), go(chatId, { messageId, noteId }),
//        chats() → [{ id, title }], activeMessage(), selectedMessages() → ids, busy() → reason or "" }
export function setupStructure(api, ctx) {
  // ---- applying and undoing ---------------------------------------------------------------------
  const toast = create("div", "structure-toast");
  toast.hidden = true;
  toast.setAttribute("role", "status");
  const toastText = create("span");
  const undoButton = create("button", "", "撤销");
  undoButton.type = "button";
  undoButton.addEventListener("click", () => void undo());
  toast.append(toastText, undoButton);
  document.body.append(toast);
  let toastTimer;
  function notice(text, undoable) {
    toastText.textContent = text;
    undoButton.hidden = !undoable;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
  }

  async function apply(op) {
    const reason = ctx.busy();
    if (reason) throw new Error(reason);
    const result = await api.structure(op);
    await ctx.refresh(result);
    notice(`${result.label}。`, true);
    return result;
  }

  // A structural edit done through another call (e.g. saving an edited picture): refresh and offer undo.
  async function report(result) {
    await ctx.refresh(result);
    notice(`${result.label}。`, true);
    return result;
  }

  async function undo() {
    try {
      const result = await api.undoStructure();
      await ctx.refresh(result);
      notice(`已撤销：${result.label}`, false);
      return result;
    } catch (error) {
      notice(error.message, false);
      return null;
    }
  }

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && key === "z" && !editable(event.target)) {
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      void undo();
    } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && key === "k") {
      event.preventDefault();
      openCommands();
    }
  });

  // ---- drag and drop ----------------------------------------------------------------------------
  // Drag sources set their payload; any chat window (or embedded chat) accepts the drop.
  function dragMessage(event, messageId) {
    event.dataTransfer.setData(messageType, JSON.stringify({ chat: ctx.chatId(), id: messageId }));
    event.dataTransfer.setData("text/plain", `ownsoft://message/${messageId}`);
    event.dataTransfer.effectAllowed = "move";
  }
  function dragNote(event, noteId) {
    event.dataTransfer.setData(noteType, JSON.stringify({ chat: ctx.chatId(), id: noteId }));
    event.dataTransfer.effectAllowed = "move";
  }
  const accepts = (types) => types.includes(messageType) || types.includes(noteType);

  // Where a drop lands: { before } (a message id, or null for the end).
  async function drop(event, spot) {
    const read = (type) => { try { return JSON.parse(event.dataTransfer.getData(type) || "null"); } catch { return null; } };
    const message = read(messageType);
    const note = read(noteType);
    const before = spot.beforeId || null;
    if (message?.id) {
      if (message.id === before || message.id === spot.afterId) return;
      await apply({ type: "move", from: message.chat, ids: [message.id], to: ctx.chatId(), before });
    } else if (note?.id) {
      if (note.chat !== ctx.chatId()) throw new Error("批注只能并入它所在会话的正文。可以先在那个会话里转成笔记块，再拖过来。");
      await apply({ type: "note-to-block", chat: note.chat, noteId: note.id, before });
    }
  }

  // ---- the command line -------------------------------------------------------------------------
  const dialog = create("dialog", "command-dialog");
  const form = create("form", "command-form");
  const input = create("input", "command-input");
  input.placeholder = "命令，例如 go 会话名 · mv <消息ID> <目标消息ID|会话> · rm <消息ID> · undo · help";
  input.setAttribute("aria-label", "命令");
  input.autocomplete = "off";
  const output = create("div", "command-output");
  form.append(input, output);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  const history = [];
  let recalled = 0;
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" && history.length) {
      recalled = Math.max(0, recalled - 1);
      input.value = history[recalled] || "";
      event.preventDefault();
    } else if (event.key === "ArrowDown" && history.length) {
      recalled = Math.min(history.length, recalled + 1);
      input.value = history[recalled] || "";
      event.preventDefault();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const line = input.value.trim();
    if (!line) return;
    history.push(line);
    recalled = history.length;
    input.value = "";
    run(line).catch((error) => print(error.message, "is-error"));
  });

  function openCommands(prefill = "") {
    if (!dialog.open) dialog.showModal();
    input.value = prefill;
    input.focus();
  }

  function print(text, className = "") {
    const line = create("pre", `command-line ${className}`.trim(), text);
    output.append(line);
    output.scrollTop = output.scrollHeight;
  }

  const help = [
    "go <会话名|会话ID|消息ID>     跳到会话或消息（别名：跳转、cd）",
    "mv <消息ID…> <目标>           移动消息；目标是消息ID（放到它前面，加 after 放后面）或会话名/ID（放到末尾）",
    "rm <消息ID…>                  移除消息（可撤销）",
    "note2block <批注ID>           把批注转为正文笔记块",
    "find <文字>                   在所有会话里找消息，结果里有消息ID",
    "log                          最近的结构操作",
    "undo [次数]                   撤销最近的结构操作（也可以在正文里按 Ctrl+Z）",
    "消息ID 可以写 .（当前选中的消息）或 sel（多选的消息）；在消息上点「复制消息 ID」可得到 ID。"
  ].join("\n");

  // Words, with "quoted phrases" kept together.
  const words = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);

  function messageIds(list) {
    return list.flatMap((word) => word === "." ? [ctx.activeMessage()].filter(Boolean)
      : word === "sel" ? ctx.selectedMessages() : [word]);
  }

  function chatByName(name) {
    const chats = ctx.chats();
    return chats.find((chat) => chat.id === name) ?? chats.find((chat) => chat.title === name) ??
      (() => {
        const matches = chats.filter((chat) => chat.title.toLowerCase().includes(name.toLowerCase()));
        if (matches.length > 1) throw new Error(`有 ${matches.length} 个会话叫「${name}」，请写完整名字或会话ID：\n` +
          matches.slice(0, 8).map((chat) => `  ${chat.title}  ${chat.id}`).join("\n"));
        return matches[0] ?? null;
      })();
  }

  async function run(line) {
    print(`> ${line}`, "is-echo");
    const [command, ...rest] = words(line);
    switch (command.toLowerCase()) {
      case "help": case "?": case "帮助":
        return print(help);
      case "go": case "cd": case "跳转": {
        const target = rest.join(" ");
        if (!target) throw new Error("go 后面写会话名、会话ID或消息ID。");
        const chat = chatByName(target);
        if (chat) {
          await ctx.go(chat.id, {});
          dialog.close();
          return;
        }
        const found = await api.findMessage(target);
        await ctx.go(found.chatId, { messageId: found.messageId });
        dialog.close();
        return;
      }
      case "mv": case "move": case "移动": {
        if (rest.length < 2) throw new Error("用法：mv <消息ID…> <目标消息ID|会话名> [after]");
        const after = ["after", "后"].includes(rest.at(-1).toLowerCase());
        const args = after ? rest.slice(0, -1) : rest;
        const target = args.at(-1);
        const ids = messageIds(args.slice(0, -1));
        if (!ids.length) throw new Error("没有要移动的消息。");
        let to;
        let before = null;
        const chat = chatByName(target);
        if (chat) to = chat.id;
        else {
          const found = await api.findMessage(target);
          to = found.chatId;
          // After a message = before the one following it.
          before = after ? found.next : found.messageId;
        }
        const result = await apply({ type: "move", ids, to, before });
        return print(result.label);
      }
      case "rm": case "del": case "删除": {
        const ids = messageIds(rest);
        if (!ids.length) throw new Error("用法：rm <消息ID…>");
        const result = await apply({ type: "remove", ids });
        return print(`${result.label}（undo 可恢复）`);
      }
      case "note2block": case "转笔记块": {
        if (!rest[0]) throw new Error("用法：note2block <批注ID>");
        const result = await apply({ type: "note-to-block", chat: ctx.chatId(), noteId: rest[0] });
        return print(result.label);
      }
      case "find": case "搜索": {
        const found = await api.searchMessages(rest.join(" "));
        if (!found.length) return print("没有找到。");
        return print(found.map((item) => `${item.messageId}  [${item.title}] ${item.preview.replace(/\s+/g, " ")}`).join("\n"));
      }
      case "log": case "历史": {
        const log = await api.structureLog();
        if (!log.length) return print("还没有可撤销的结构操作。");
        return print(log.map((item) => `${new Date(item.at).toLocaleTimeString()}  ${item.label}`).join("\n"));
      }
      case "undo": case "撤销": {
        const times = Math.min(30, Math.max(1, Number(rest[0]) || 1));
        for (let index = 0; index < times; index += 1) {
          const result = await undo();
          if (!result) break;
          print(`已撤销：${result.label}`);
        }
        return;
      }
      default:
        throw new Error(`不认识的命令「${command}」。输入 help 看看能做什么。`);
    }
  }

  return { apply, report, undo, notice, dragMessage, dragNote, accepts, drop, openCommands };
}
