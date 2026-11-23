import assert from "node:assert/strict";
import { test } from "node:test";
import { NotebookStore } from "./store.mjs";
import { matchingModelSession, modelContextFingerprint, modelSessionIdentity } from "./model-session.mjs";

test("native session resumes only while the selected chat context and identity still match", () => {
  const store = new NotebookStore(":memory:");
  try {
    const speaker = { member: { id: "one", name: "gpt1", model: "model-a", effort: "high", prompt: "" },
      profile: { id: "account-a", provider: "gpt" }, group: { members: [{ name: "gpt1" }] } };
    const first = store.saveReply(null, "原问题", "原回答");
    const key = "main:one";
    const fingerprint = modelContextFingerprint(first, null, {});
    const record = { id: "native-1", fingerprint, epoch: 0, profileId: "account-a", provider: "gpt",
      model: "model-a", effort: "high", cwd: "C:/work", identity: modelSessionIdentity(speaker) };
    store.saveModelSession(first.id, key, record);
    const state = store.read();
    assert.equal(matchingModelSession(state, key, speaker, "C:/work", fingerprint), "native-1");
    assert.equal(matchingModelSession(state, "branch:other:one", speaker, "C:/work", fingerprint), null);
    assert.equal(matchingModelSession(state, key, { ...speaker, profile: { id: "account-b", provider: "gpt" } },
      "C:/work", fingerprint), null);
    assert.equal(matchingModelSession(state, key, { ...speaker, member: { ...speaker.member, prompt: "新角色" } },
      "C:/work", fingerprint), null);
    const questionId = state.blocks.find((block) => block.kind === "question").id;
    const answerId = state.blocks.find((block) => block.kind === "reply").id;
    store.change({ type: "set-context", ids: [questionId], noteIds: [] });
    const selected = store.read();
    assert.notEqual(modelContextFingerprint(selected, null, {}), fingerprint);
    assert.equal(matchingModelSession(selected, key, speaker, "C:/work",
      modelContextFingerprint(selected, null, {})), null);
    store.change({ type: "clear-context" });
    store.change({ type: "edit-document", title: store.read().title,
      messages: [{ ids: [answerId], text: "修订后的回答" }] });
    assert.notEqual(modelContextFingerprint(store.read(), null, {}), fingerprint);
    store.change({ type: "set-model-session-mode", mode: "manual" });
    assert.equal(matchingModelSession(store.read(), key, speaker, "C:/work", fingerprint), null);
  } finally {
    store.close();
  }
});

test("PDF session fingerprint uses the content hash without serializing PDF bytes", () => {
  const store = new NotebookStore(":memory:");
  try {
    const state = { ...store.read(), parent: { kind: "pdf-comment", hash: "content-hash" } };
    const source = { context: "第 3 页的批注", pdf: { name: "paper.pdf",
      get bytes() { throw new Error("PDF bytes must not be serialized"); } } };
    const fingerprint = modelContextFingerprint(state, null, source);
    assert.equal(fingerprint, modelContextFingerprint(state, null, source));
    assert.notEqual(fingerprint, modelContextFingerprint({ ...state, parent: { ...state.parent, hash: "updated" } },
      null, source));
    assert.notEqual(fingerprint, modelContextFingerprint(state, null,
      { ...source, refs: [{ id: "attachment-1", name: "figure.png", extension: ".png" }] }));
  } finally {
    store.close();
  }
});
