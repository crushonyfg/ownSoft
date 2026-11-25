// Shows a chat inside another view: the app's own page in embedded mode ("index.html?embed=<id>"),
// so the conversation has everything the main chat has. Reuses the frame when the chat is the same.
// params: extra query parameters used when the frame (re)loads, e.g. { mirror: "1", focus: noteId }.
const hosts = new WeakMap();
function ready(host) { host.classList.remove("chat-opening"); host.removeAttribute("aria-busy"); }
export function openingChat(host) {
  host.classList.add("chat-opening"); host.setAttribute("aria-busy", "true");
  return () => ready(host);
}
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "ownsoft:embed-ready") return;
  const host = hosts.get(event.source), frame = host?.querySelector(":scope > iframe.embedded-chat");
  if (frame?.dataset.chatId !== event.data.chatId) return;
  frame.dataset.ready = event.data.chatId;
  ready(host);
});
export function embedChat(host, chatId, { label = "对话", params = {} } = {}) {
  let frame = host.querySelector(":scope > iframe.embedded-chat");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "embedded-chat";
    host.replaceChildren(frame);
    if (frame.contentWindow) hosts.set(frame.contentWindow, host);
    frame.addEventListener("load", () => {
      try {
        if (new URL(frame.contentWindow.location.href).searchParams.get("embed") === frame.dataset.chatId) {
          hosts.set(frame.contentWindow, host); frame.dataset.ready = frame.dataset.chatId; ready(host);
        }
      } catch {}
    });
  }
  frame.title = label;
  if (frame.dataset.chatId !== chatId) {
    openingChat(host);
    frame.dataset.chatId = chatId;
    const query = new URLSearchParams({ embed: chatId, ...params });
    frame.src = `index.html?${query}`;
  } else if (frame.dataset.ready === chatId) ready(host);
  return frame;
}
