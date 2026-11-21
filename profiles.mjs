import { randomUUID } from "node:crypto";

const providers = new Set(["gpt", "claude"]);
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export class Profiles {
  constructor(db) {
    db.exec("CREATE TABLE IF NOT EXISTS model_settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
    const initial = {
      provider: "gpt",
      active: { gpt: "gpt-native", claude: "claude-native" },
      profiles: [...providers].map((provider) => ({
        id: `${provider}-native`, name: "本机账户", provider, native: true, model: "", efforts: {}
      }))
    };
    db.prepare("INSERT OR IGNORE INTO model_settings VALUES (1, ?)").run(JSON.stringify(initial));
    this.select = db.prepare("SELECT data FROM model_settings WHERE id = 1");
    this.update = db.prepare("UPDATE model_settings SET data = ? WHERE id = 1");
  }

  read() {
    return JSON.parse(this.select.get().data);
  }

  get(id) {
    const state = this.read();
    const profile = state.profiles.find((item) => item.id === (id ?? state.active[state.provider]));
    if (!profile) throw new Error("找不到这个账户配置。");
    return profile;
  }

  change(action) {
    const state = this.read();
    const profile = state.profiles.find((item) => item.id === state.active[state.provider]);
    if (action.type === "provider") {
      if (!providers.has(action.provider)) throw new Error("未知服务商。");
      state.provider = action.provider;
    } else if (action.type === "select") {
      const next = state.profiles.find((item) => item.id === action.id && item.provider === state.provider);
      if (!next) throw new Error("找不到这个账户配置。");
      state.active[state.provider] = next.id;
    } else if (action.type === "add") {
      const name = typeof action.name === "string" ? action.name.trim() : "";
      if (!name || name.length > 50) throw new Error("账户名称请输入 1 到 50 个字符。");
      if (state.profiles.some((item) => item.provider === state.provider && item.name === name)) {
        throw new Error("已有同名账户配置。");
      }
      const id = randomUUID();
      state.profiles.push({ id, name, provider: state.provider, native: false, model: "", efforts: {} });
      state.active[state.provider] = id;
    } else if (action.type === "model") {
      if (typeof action.model !== "string" || !/^[a-zA-Z0-9_.-]{0,100}$/.test(action.model)) throw new Error("模型名称无效。");
      profile.model = action.model;
    } else if (action.type === "effort") {
      if (action.effort && !efforts.has(action.effort)) throw new Error("Effort 无效。");
      profile.efforts[profile.model] = action.effort || "";
    } else {
      throw new Error("未知账户设置。");
    }
    this.update.run(JSON.stringify(state));
    return state;
  }
}
