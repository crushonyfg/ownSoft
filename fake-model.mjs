// A stand-in for the model CLIs, for trying the app without using a subscription.
// Enabled only when AI_NOTEBOOK_FAKE_MODELS=1: every member answers with a short canned reply,
// streamed over a few seconds, and can be stopped like a real one.
export class FakeModel {
  constructor(provider) {
    this.provider = provider;
  }

  async account() {
    return { signedIn: true, plan: "test", email: "" };
  }

  async models() {
    return [];
  }

  async login() {}

  async answer(input, { signal, update, activity = () => {}, thinking = () => {}, tool = () => {}, usage = () => {} }) {
    const name = input.persona?.name || this.provider;
    const text = `（测试回答 · ${name}）收到：「${input.question.slice(0, 60)}」。\n\n` +
      `上下文里有 ${input.history.length} 轮对话、${input.files?.length || 0} 个附件文件` +
      `${input.files?.length ? `（${input.files.map((file) => `${file.name}${file.pages ? ` ${file.pages} 页` : ""}`).join("、")}）` : ""}。` +
      "这是一段用来测试界面的假回答，会慢慢显示出来。";
    activity("正在思考");
    thinking({ id: "test-commentary", kind: "commentary", text: "正在检查演示输入和上下文。" });
    thinking({ id: "test-summary", kind: "summary", text: "正在组织演示回答。" });
    tool({ id: "test-tool", title: "演示工具", detail: "检查演示输入", status: "done", result: "演示检查完成。" });
    let shown = "";
    for (const piece of text.match(/.{1,6}/gsu)) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 180);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("已停止生成。")); }, { once: true });
      });
      shown += piece;
      update(shown);
    }
    usage({ inputTokens: 0, outputTokens: 0 });
    return shown;
  }
}
