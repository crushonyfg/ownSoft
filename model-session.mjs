import { createHash } from "node:crypto";
import { turnInput } from "./notebook.mjs";

// A native session is a cache of the app's authoritative chat. Rebuild it whenever the visible
// transcript, selected notes, inherited source, identity, account or working folder changes.
export function modelContextFingerprint(notebook, branch, parent) {
  const base = turnInput(notebook, branch, "", false);
  // PDF bytes are already identified by the review's content hash. Serializing a Buffer here
  // would turn every byte into a JSON number, several times per turn for a PDF conversation.
  const source = { context: parent?.context || "", history: parent?.history || [],
    refs: (parent?.refs || []).map(({ id, name, extension }) => ({ id, name, extension })),
    pdf: parent?.pdf ? { hash: notebook.parent?.hash || "", name: parent.pdf.name } : null };
  return createHash("sha256").update(JSON.stringify({ base, source })).digest("hex");
}

export function modelSessionIdentity({ member, group }) {
  return JSON.stringify({ name: member.name, role: member.prompt || "",
    peers: group.members.map((item) => item.name) });
}

export function matchingModelSession(notebook, key, speaker, cwd, fingerprint) {
  if (notebook.modelSessionMode === "manual") return null;
  const record = notebook.modelSessions?.[key];
  return record && record.fingerprint === fingerprint && record.epoch === (notebook.modelSessionEpoch || 0) &&
    record.profileId === speaker.profile.id && record.provider === speaker.profile.provider &&
    record.model === speaker.member.model && record.effort === (speaker.member.effort || "") &&
    record.identity === modelSessionIdentity(speaker) && record.cwd === cwd ? record.id : null;
}
