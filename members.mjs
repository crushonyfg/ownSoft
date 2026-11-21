import { randomUUID } from "node:crypto";

// A roster is { members, defaultMember }. The app keeps one as the default for new chats, and a
// chat gets its own copy the first time its members are changed. Members can share an account
// and differ by name, model and role prompt (several personas on one subscription).
export const avatarIds = ["human", "robot", "fox", "cat", "owl", "frog", "bear", "bunny"];
const avatars = new Set(avatarIds);
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const providerPrefix = { gpt: "gpt", claude: "claude", gemini: "gemini" };
export const memberNamePattern = /^[\p{L}\p{N}_-]{1,24}$/u;
export const maxMembers = 24;
export const maxPrompt = 4000;

function checkName(roster, name, exceptId) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!memberNamePattern.test(value)) throw new Error("成员名请用 1 到 24 个字母、数字、汉字、- 或 _，不要有空格（@ 时要用）。");
  if (roster.members.some((item) => item.id !== exceptId && item.name.toLowerCase() === value.toLowerCase())) {
    throw new Error(`已经有叫「${value}」的成员。`);
  }
  return value;
}

function checkModel(model) {
  if (typeof model !== "string" || !/^[a-zA-Z0-9_.-]{0,100}$/.test(model)) throw new Error("模型名称无效。");
  return model;
}

function checkPrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length > maxPrompt) throw new Error(`角色设定最多 ${maxPrompt} 字。`);
  return prompt.trim();
}

function nextName(roster, base) {
  for (let n = 1; ; n += 1) {
    const name = `${base}${n}`;
    if (!roster.members.some((item) => item.name.toLowerCase() === name.toLowerCase())) return name;
  }
}

export function addMember(roster, account, fields = {}, defaultAvatar = "robot") {
  if (roster.members.length >= maxMembers) throw new Error(`最多 ${maxMembers} 位成员。`);
  const member = {
    id: randomUUID(),
    name: fields.name ? checkName(roster, fields.name) : nextName(roster, providerPrefix[account.provider] || "ai"),
    profileId: account.id, model: checkModel(fields.model ?? account.model ?? ""),
    effort: fields.effort ?? account.efforts?.[account.model] ?? "",
    avatar: avatars.has(fields.avatar) ? fields.avatar : defaultAvatar,
    prompt: fields.prompt ? checkPrompt(fields.prompt) : ""
  };
  roster.members.push(member);
  roster.defaultMember ??= member.id;
  return member;
}

export function applyMemberChange(roster, action, accounts, avatarFor = () => "robot") {
  const findMember = (id) => {
    const member = roster.members.find((item) => item.id === id);
    if (!member) throw new Error("这位成员已不存在。");
    return member;
  };
  const findAccount = (id) => {
    const account = accounts.find((item) => item.id === id);
    if (!account) throw new Error("找不到这个账户配置。");
    return account;
  };
  switch (action.type) {
    case "member-add": {
      const current = roster.members.find((item) => item.id === roster.defaultMember);
      const account = findAccount(action.profileId ?? current?.profileId ?? accounts[0]?.id);
      return addMember(roster, account, action, avatarFor(account.provider));
    }
    case "member-update": {
      const member = findMember(action.id);
      if (action.name !== undefined) member.name = checkName(roster, action.name, member.id);
      if (action.profileId !== undefined && action.profileId !== member.profileId) {
        const before = accounts.find((item) => item.id === member.profileId);
        const after = findAccount(action.profileId);
        // A member still wearing the old app's default face takes the new app's, so a Claude-looking
        // fox does not keep answering for Gemini.
        if (before && before.provider !== after.provider && member.avatar === avatarFor(before.provider) &&
            action.avatar === undefined) {
          member.avatar = avatarFor(after.provider);
        }
        member.profileId = after.id;
        member.model = "";
        member.effort = "";
      }
      if (action.model !== undefined) {
        member.model = checkModel(action.model);
        member.effort = "";
      }
      if (action.effort !== undefined) {
        if (action.effort && !efforts.has(action.effort)) throw new Error("Effort 无效。");
        member.effort = action.effort;
      }
      if (action.avatar !== undefined) {
        if (!avatars.has(action.avatar)) throw new Error("头像无效。");
        member.avatar = action.avatar;
      }
      if (action.prompt !== undefined) member.prompt = checkPrompt(action.prompt);
      return member;
    }
    case "member-remove": {
      findMember(action.id);
      if (roster.members.length === 1) throw new Error("至少保留一位成员。");
      roster.members = roster.members.filter((item) => item.id !== action.id);
      if (roster.defaultMember === action.id) roster.defaultMember = roster.members[0].id;
      return null;
    }
    case "member-default":
      roster.defaultMember = findMember(action.id).id;
      return null;
    // One member for every account that has none in this roster yet.
    case "members-import": {
      let added = 0;
      for (const account of accounts) {
        if (roster.members.some((item) => item.profileId === account.id)) continue;
        addMember(roster, account, {}, avatarFor(account.provider));
        added += 1;
      }
      return added;
    }
    default:
      throw new Error("未知的成员操作。");
  }
}
