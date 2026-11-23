// Shows a chat inside another view: the app's own page in embedded mode ("index.html?embed=<id>"),
// so the conversation has everything the main chat has. Reuses the frame when the chat is the same.
// params: extra query parameters used when the frame (re)loads, e.g. { mirror: "1", focus: noteId }.
export function embedChat(host, chatId, { label = "对话", params = {} } = {}) {
  let frame = host.querySelector(":scope > iframe.embedded-chat");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "embedded-chat";
    host.replaceChildren(frame);
  }
  frame.title = label;
  if (frame.dataset.chatId !== chatId) {
    frame.dataset.chatId = chatId;
    const query = new URLSearchParams({ embed: chatId, ...params });
    frame.src = `index.html?${query}`;
  }
  return frame;
}
