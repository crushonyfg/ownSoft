import assert from "node:assert/strict";
import { test } from "node:test";
import { documentOrigin, commentInput, sharedNoteBlocks, sharedNoteContext, threadInput, turnInput } from "./notebook.mjs";
import { NotebookStore } from "./store.mjs";
import { allAttachmentRefs } from "./attachments.mjs";
import { decodeReview, encodeReview } from "./pdf-review.mjs";

const pdfRef = { id: "11111111-2222-4333-8444-555555555555", extension: ".pdf", name: "论文.pdf", size: 2048 };
const imageRef = { id: "66666666-7777-4888-9999-aaaaaaaaaaaa", extension: ".png", name: "截图.png", size: 512 };

test("a PDF's review belongs to the PDF and reaches the group chat through its note", () => {
  const store = new NotebookStore(":memory:");
  try {
    const notebook = store.change({ type: "add-note-images", refs: [pdfRef] });
    const block = notebook.blocks.at(-1);
    assert.equal(block.noteType, "pdf");
    assert.equal(block.review, undefined);
    const hash = "a".repeat(64);
    const comment = { id: "c-1", page: 3, rects: [[.1, .2, .5, .25]], title: "我的批注", text: "这里缺对照实验。",
      quote: "we show that", priority: "", turns: [{ id: "t-1", question: "补什么？", answer: "补一个基线。",
        source: { provider: "claude", model: "", effort: "", memberId: "m-1", memberName: "claude1", avatar: "fox" },
        attachments: [imageRef] }] };
    const chat = [{ id: "t-2", question: "总结贡献", answer: "三点贡献。", source: { provider: "gemini", model: "", effort: "" } }];
    assert.equal(store.pdfReview(hash), null);
    const review = store.savePdfReview(hash, "论文.pdf", { comments: [comment], chat, page: 3 });
    assert.equal(review.page, 3);
    assert.equal(review.comments[0].turns[0].source.memberName, "claude1");
    assert.equal(review.chat[0].source.provider, "gemini");
    store.pdfReviewPage(hash, 5);
    assert.equal(store.pdfReview(hash).page, 5);
    assert.deepEqual(store.pdfReviews().map(({ name, comments, chat: turns, page }) => [name, comments, turns, page]),
      [["论文.pdf", 1, 1, 5]]);
    // Files asked about inside the review stay in use.
    assert.deepEqual(store.pdfReviewAttachments().map((ref) => ref.id), [imageRef.id]);
    // When answering, the main process attaches the review to the chat's PDF note.
    const withReview = structuredClone(notebook);
    withReview.blocks.at(-1).review = { comments: review.comments, chat: review.chat };
    assert.deepEqual(sharedNoteBlocks(withReview).flatMap((item) => item.attachments), [pdfRef]);
    assert.match(sharedNoteContext(withReview), /PDF「论文\.pdf」[\s\S]+第 3 页「we show that」（我的批注）：这里缺对照实验/);
    store.removePdfReview(hash);
    assert.equal(store.pdfReview(hash), null);
    assert.throws(() => store.pdfReview("not-a-hash"), /审阅记录无效/);
  } finally {
    store.close();
  }
});

test("side threads are private until published, and publishing puts the edited transcript in context", () => {
  const store = new NotebookStore(":memory:");
  try {
    let notebook = store.saveReply(null, "主问题", "主回答。");
    notebook = store.change({ type: "add-thread", memberId: "m-claude" });
    const thread = notebook.threads[0];
    assert.equal(thread.visibility, "private");
    notebook = store.saveThreadReply(notebook.id, thread.id, { id: "turn-1", question: "私下问", answer: "私下答。" });
    // The thread sees the main chat plus its own turns; the main chat does not see the thread.
    const input = threadInput(notebook, notebook.threads[0], "继续");
    assert.deepEqual(input.history.map((turn) => turn.question), ["主问题", "私下问"]);
    assert.match(input.context, /单独对话/);
    assert.doesNotMatch(JSON.stringify(turnInput(notebook, null, "下一问")), /私下答/);

    notebook = store.change({ type: "edit-thread-turn", id: thread.id, turnId: "turn-1", answer: "整理后的回答。" });
    notebook = store.change({ type: "publish-thread", id: thread.id, text: "**claude1**：整理后的回答。",
      source: { memberId: "m-claude", memberName: "claude1", avatar: "fox", provider: "claude" } });
    const published = notebook.blocks.at(-1);
    assert.equal(published.noteType, "thread");
    assert.equal(notebook.threads[0].visibility, "public");
    assert.match(sharedNoteContext(notebook), /分头讨论记录（用户与 claude1 单独对话后发布）[\s\S]+整理后的回答/);

    // Publishing again updates the same block; withdrawing removes it from the chat.
    notebook = store.change({ type: "publish-thread", id: thread.id, text: "更短的版本。" });
    assert.equal(notebook.blocks.filter((block) => block.noteType === "thread" && !block.removed).length, 1);
    assert.equal(notebook.blocks.at(-1).text, "更短的版本。");
    notebook = store.change({ type: "unpublish-thread", id: thread.id });
    assert.equal(notebook.threads[0].visibility, "private");
    assert.doesNotMatch(sharedNoteContext(notebook), /更短的版本/);

    notebook = store.change({ type: "delete-thread-turn", id: thread.id, turnId: "turn-1" });
    assert.equal(notebook.threads[0].turns.length, 0);
    notebook = store.change({ type: "delete-thread", id: thread.id });
    assert.equal(notebook.threads.length, 0);
  } finally {
    store.close();
  }
});

test("a whole-PDF conversation gets the review's annotations as context", () => {
  const origin = documentOrigin("论文.pdf", [{ page: 2, quote: "原句", title: "", text: "需要引用。" }]);
  const input = commentInput(origin, [{ question: "先前", answer: "回答" }], "总结一下");
  assert.match(input.context, /来源：论文\.pdf[\s\S]+附件文件里[\s\S]+第 2 页「原句」：需要引用/);
  assert.equal(input.history.length, 1);
});

test("a standalone .aipdf keeps its whole-document conversation", () => {
  const pdf = Buffer.from("%PDF-1.4\nexample\n%%EOF");
  const chat = [{ id: "turn-1", question: "主要贡献？", answer: "两点。", source: { provider: "gpt", model: "", effort: "" },
    tools: [{ id: "x", title: "web_search", detail: "", status: "done" }] }];
  const saved = decodeReview(encodeReview(pdf, "原稿.pdf", [], chat));
  assert.deepEqual(saved.chat, chat);
  assert.deepEqual(decodeReview(encodeReview(pdf, "原稿.pdf", [])).chat, []);
});

test("a private window opened from a message starts from that message", () => {
  const store = new NotebookStore(":memory:");
  try {
    let notebook = store.saveReply(null, "问题", "原回答。");
    notebook = store.change({ type: "add-thread", memberId: "m-1",
      origin: { messageId: notebook.blocks.at(-1).id, speaker: "gemini", text: "原回答。" } });
    const thread = notebook.threads[0];
    assert.equal(thread.origin.speaker, "gemini");
    assert.match(threadInput(notebook, thread, "展开说说").context, /从群聊里的这条消息开始[\s\S]+gemini[\s\S]+原回答/);
  } finally {
    store.close();
  }
});

test("an answer moved to a private window leaves a folded card that stays out of context", () => {
  const store = new NotebookStore(":memory:");
  try {
    let notebook = store.saveReply(null, "先前的问题", "先前的回答。");
    notebook = store.change({ type: "add-thread", memberId: "m-gemini", stub: "@gemini1 现在适合入场吗？" });
    const thread = notebook.threads.at(-1);
    const stub = notebook.blocks.at(-1);
    assert.equal(stub.noteType, "thread-stub");
    assert.equal(stub.threadId, thread.id);
    assert.doesNotMatch(JSON.stringify(turnInput(notebook, null, "下一问")), /适合入场/);
    notebook = store.change({ type: "delete-thread", id: thread.id });
    assert.equal(notebook.blocks.find((block) => block.id === stub.id).removed, true);
  } finally {
    store.close();
  }
});
