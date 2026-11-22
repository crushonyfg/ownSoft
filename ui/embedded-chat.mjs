// Shows a chat inside another view: the app's own page in embedded mode ("index.html?embed=<id>"),
// so the conversation has everything the main chat has. Reuses the frame when the chat is the same.
export function embedChat(host, chatId, { label = "对话" } = {}) {
  let frame = host.querySelector(":scope > iframe.embedded-chat");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "embedded-chat";
    host.replaceChildren(frame);
  }
  frame.title = label;
  if (frame.dataset.chatId !== chatId) {
    frame.dataset.chatId = chatId;
    frame.src = `index.html?embed=${encodeURIComponent(chatId)}`;
  }
  return frame;
}
