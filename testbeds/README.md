# 当前笔记 testbed

`current-notes.zip` 是用户要求随仓库提供的真实笔记快照，不是虚构示例。当前仓库公开，快照中的正文、问答、批注也会公开。`manifest.json` 记录导出时间、数量和 ZIP 的 SHA-256。

## 在另一台机器打开

在仓库目录运行（需要 Node.js 22.13+，推荐 24+）：

```powershell
git pull
npm ci
npm run testbed:start
```

首次运行自动把 ZIP 安装到仓库的 `.testbed-data/current-notes`，以后继续使用这个目录，编辑会保留。此目录已被 Git 忽略，不会随下一次提交上传。testbed 使用独立应用配置，不覆盖 `%USERPROFILE%/.ai-notebook` 中的已有笔记，也不自动改变默认数据目录。

如果同一代码目录下已经运行应用，先正常关闭它，再启动 testbed，以免单实例机制转到旧窗口。要回到原来的笔记，关闭 testbed 后运行 `npm start`。

也可以只准备数据到自己选的空目录：

```powershell
npm run testbed:prepare -- --target "D:\OwnSoftTestbed"
npm run testbed:start -- --target "D:\OwnSoftTestbed"
```

目标已有数据库时，prepare 会拒绝覆盖。想重新载入仓库快照，请选择另一个空目录；`git pull` 不会覆盖已经导入后的本地修改。

## 在正常应用中恢复

也可在「数据管理 → 从文件恢复…」选择 `testbeds/current-notes.zip`。这是整库恢复，会替换当前笔记，应用会先自动备份；它不是把两套已有笔记自动合并。已有重要笔记时，推荐上面的独立 testbed 启动方式。

## 快照包含什么

- 正文、批注、分支、文档选区/全文聊天、会话历史、文件版本以及附件和 PDF 审阅副本。
- Markdown 保留完整应用草稿和批注，解除原电脑文件路径绑定；另一台机器可用「另存为…」选择新文件位置。
- 不携带账户配置、登录凭据、CLI 会话、工作目录、模型缓存、备份或撤销日志；需要在新机器自行安装并登录 Codex / Claude。
- 定时任务保留内容但关闭自动 AI 执行，避免导入后立即触发任务。正文里原本提到的文件路径是笔记文字，不代表那些项目文件也已打包。

开发者重新导出当前笔记（只读源数据库，只修改临时快照）：

```powershell
node scripts/testbed.mjs export --source "$env:USERPROFILE\.ai-notebook"
```

发布前应检查快照适合公开。导出会检测常见 API / GitHub 凭据格式并拒绝打包，但不能代替内容审阅。
