import { randomUUID } from "node:crypto";
import { addMember, applyMemberChange, avatarIds } from "./members.mjs";

// Accounts ("profiles") are logins to a provider's CLI. Members are the named personas in the group
// chat (gpt1, claude2, …); each speaks through one account. The roster kept here is the default
// for chats that have not set up their own members.
const providers = new Set(["gpt", "claude", "gemini"]);
const backgrounds = new Set(["garden", "sky", "paper", "night"]);
export { avatarIds };
const avatars = new Set(avatarIds);
const defaultAppearance = { background: "garden", userAvatar: "human", gptAvatar: "robot", claudeAvatar: "fox" };

export function providerAvatar(appearance, provider) {
  const chosen = { ...defaultAppearance, ...appearance };
  return provider === "claude" ? chosen.claudeAvatar : provider === "gpt" ? chosen.gptAvatar : "owl";
}

// Settings saved before group chat had one active account per provider; each account becomes a member.
function migrate(state) {
  if (Array.isArray(state.members) && state.members.length) return false;
  state.members = [];
  for (const profile of state.profiles) addMember(state, profile, {}, providerAvatar(state.appearance, profile.provider));
  const active = state.profiles.find((item) => item.id === state.active?.[state.provider]);
  state.defaultMember = state.members.find((item) => item.profileId === active?.id)?.id ?? state.members[0]?.id;
  return true;
}

// The default roster has a member for every account (gpt1, claude1, gemini1 …). Done once for
// settings saved before that, so a member removed on purpose later is not brought back.
function fillAccountMembers(state) {
  if (state.accountMembers) return false;
  for (const profile of state.profiles) {
    if (state.members.some((item) => item.profileId === profile.id)) continue;
    try {
      addMember(state, profile, {}, providerAvatar(state.appearance, profile.provider));
    } catch {
      break;
    }
  }
  state.accountMembers = true;
  return true;
}

export class Profiles {
  constructor(db) {
    db.exec("CREATE TABLE IF NOT EXISTS model_settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
    const initial = {
      provider: "gpt",
      active: { gpt: "gpt-native", claude: "claude-native" },
      appearance: defaultAppearance,
      profiles: ["gpt", "claude"].map((provider) => ({
        id: `${provider}-native`, name: "本机账户", provider, native: true, model: "", efforts: {}
      }))
    };
    db.prepare("INSERT OR IGNORE INTO model_settings VALUES (1, ?)").run(JSON.stringify(initial));
    this.select = db.prepare("SELECT data FROM model_settings WHERE id = 1");
    this.update = db.prepare("UPDATE model_settings SET data = ? WHERE id = 1");
    const state = JSON.parse(this.select.get().data);
    const migrated = migrate(state);
    // Gemini (through Antigravity) arrived later: its local login appears as an account.
    const addedGemini = !state.profiles.some((item) => item.provider === "gemini");
    if (addedGemini) state.profiles.push({ id: "gemini-native", name: "本机账户", provider: "gemini", native: true, model: "", efforts: {} });
    const filled = fillAccountMembers(state);
    if (migrated || addedGemini || filled) this.update.run(JSON.stringify(state));
  }

  read() {
    const state = JSON.parse(this.select.get().data);
    state.usage ??= {};
    state.accountUsage ??= {};
    state.limits ??= {};
    return state;
  }

  #save(state) {
    this.update.run(JSON.stringify(state));
    return state;
  }

  profile(id) {
    const profile = this.read().profiles.find((item) => item.id === id);
    if (!profile) throw new Error("找不到这个账户配置。");
    return profile;
  }

  // The member who answers: the one asked for, else the default member.
  member(id) {
    const state = this.read();
    const member = state.members.find((item) => item.id === (id || state.defaultMember)) ?? state.members[0];
    if (!member) throw new Error("还没有群聊成员，请先在「成员」里添加。");
    const profile = state.profiles.find((item) => item.id === member.profileId);
    if (!profile) throw new Error(`成员「${member.name}」的账户已被删除，请重新指定账户。`);
    return { member, profile };
  }

  // Counted after every reply; tokens are whatever the CLI reported.
  recordUsage(memberId, { inputTokens = 0, outputTokens = 0 } = {}, now = new Date(), profileId) {
    const state = this.read();
    const day = now.toISOString().slice(0, 10);
    const add = (table, key) => {
      const entry = table[key] ?? { turns: 0, inputTokens: 0, outputTokens: 0 };
      if (entry.day !== day) Object.assign(entry, { day, dayTurns: 0, dayInput: 0, dayOutput: 0 });
      entry.turns += 1;
      entry.dayTurns += 1;
      entry.inputTokens += Math.max(0, Number(inputTokens) || 0);
      entry.outputTokens += Math.max(0, Number(outputTokens) || 0);
      entry.dayInput += Math.max(0, Number(inputTokens) || 0);
      entry.dayOutput += Math.max(0, Number(outputTokens) || 0);
      entry.lastUsed = now.getTime();
      table[key] = entry;
    };
    add(state.usage, memberId);
    if (profileId) add(state.accountUsage, profileId);
    this.#save(state);
  }

  // Limit information a CLI reported during a reply (Claude sends it only in passing).
  recordLimits(profileId, limits) {
    if (!limits?.length) return;
    const state = this.read();
    const known = new Map((state.limits[profileId]?.items || []).map((item) => [item.key, item]));
    for (const item of limits) known.set(item.key, item);
    state.limits[profileId] = { items: [...known.values()], updated: Date.now() };
    this.#save(state);
  }

  change(action) {
    const state = this.read();
    const findMember = (id) => {
      const member = state.members.find((item) => item.id === id);
      if (!member) throw new Error("这位成员已不存在。");
      return member;
    };
    const findProfile = (id) => {
      const profile = state.profiles.find((item) => item.id === id);
      if (!profile) throw new Error("找不到这个账户配置。");
      return profile;
    };
    const defaultMember = () => state.members.find((item) => item.id === state.defaultMember) ?? state.members[0];
    switch (action.type) {
      case "member-add":
      case "member-update":
      case "member-remove":
      case "member-default":
      case "members-import": {
        const result = applyMemberChange(state, action, state.profiles, (provider) => providerAvatar(state.appearance, provider));
        if (action.type === "members-import") state.lastImport = result;
        break;
      }
      case "account-add": {
        if (!providers.has(action.provider)) throw new Error("未知服务商。");
        if (action.provider === "gemini") throw new Error("Antigravity 只能使用本机这一个 Google 登录，不能再加账户。");
        const name = typeof action.name === "string" ? action.name.trim() : "";
        if (!name || name.length > 50) throw new Error("账户名称请输入 1 到 50 个字符。");
        if (state.profiles.some((item) => item.provider === action.provider && item.name === name)) {
          throw new Error("已有同名账户配置。");
        }
        const profile = { id: randomUUID(), name, provider: action.provider, native: false, model: "", efforts: {} };
        state.profiles.push(profile);
        addMember(state, profile, {}, providerAvatar(state.appearance, profile.provider));
        break;
      }
      case "account-remove": {
        const profile = findProfile(action.id);
        if (profile.native) throw new Error("本机账户不能删除。");
        const remaining = state.members.filter((item) => item.profileId !== profile.id);
        if (!remaining.length) throw new Error("删除后就没有成员了，请先添加使用其他账户的成员。");
        state.profiles = state.profiles.filter((item) => item.id !== profile.id);
        state.members = remaining;
        if (!remaining.some((item) => item.id === state.defaultMember)) state.defaultMember = remaining[0].id;
        delete state.limits[profile.id];
        break;
      }
      // The ribbon's model and effort pickers edit the default member.
      case "model":
      case "effort":
        applyMemberChange(state, { type: "member-update", id: defaultMember().id, [action.type]: action[action.type] || "" },
          state.profiles);
        break;
      case "appearance": {
        const next = { ...defaultAppearance, ...state.appearance, ...action.appearance };
        if (!backgrounds.has(next.background) ||
            ![next.userAvatar, next.gptAvatar, next.claudeAvatar].every((avatar) => avatars.has(avatar))) {
          throw new Error("外观设置无效。");
        }
        state.appearance = next;
        break;
      }
      default:
        throw new Error("未知账户设置。");
    }
    return this.#save(state);
  }
}
