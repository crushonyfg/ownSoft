# 开发须知（给所有参与开发的 agent）

动手前先读完这一页。用户的说明和回复一律用中文。

## 开发重点：按功能模块开发，不要堆叠

**一种能力只实现一次，其他地方都复用这个实现。** 不要为了在新位置用上某个功能，就在那里再写一份精简版。

### 教训

PDF 审阅的全文对话、批注追问、侧边分支、私聊小窗，最早都各自写了一套简化的问答列表（`ui/comment-chat.mjs`、`ui/threads-ui.mjs` 里的 turns 列表等），数据也各存一份（`turns` / `chat` 数组塞在笔记、PDF 审阅、MD 文档里）。结果主会话后来加的编辑、收起、高亮、下划线、转笔记块或批注、多选、选上下文、@ 多位成员，这些地方一个都用不上。要补齐，只能把数据迁成统一的会话、把界面换成嵌入完整会话，前后做了两个阶段，改动遍布 store、main、preload 和五六个界面文件。

后来又犯过一次：放大批注左边的“原文”是另写的一份只读渲染，高亮、批注、提问等在那里全都无效，最后改成嵌入同一个会话（`embedChat(..., { params: { mirror: "1", focus } })`）。只要是“显示一段会话”，哪怕只是为了看原文，也用会话组件。

后面还要做图、树等更多结构。如果继续每个位置各写一份，主模块每加一个功能，就得去每个次级结构里再补一遍，迟早补不齐，也改不动。

### 怎么做

- **会话只有一种。** 任何地方出现一段对话，它都是一个完整会话（一个 notebook），用 `parent` 记住自己来自哪里（哪条批注、哪个分支、哪份 PDF 或文档）。数据层见 `child-chats.mjs` 和 `store.mjs` 里的 child chat 方法（`openChildChat`、`childChatId`、`appendChildTurn` 等），索引表是 `child_chats`。
- **界面只有一个会话组件。** 要在某处显示对话，就用 `ui/embedded-chat.mjs` 的 `embedChat(host, chatId)` 嵌入完整会话（`index.html?embed=<id>`），或用 `api.openChildChat(...)` 在新窗口打开。不要再写新的问答列表。嵌入模式的布局差异集中在 `body[data-embed="1"]` 的样式里。
- **主会话加了功能，所有嵌入处自动就有。** 如果某个功能在嵌入时需要不同表现，就在会话组件里按嵌入模式分支处理，不要去宿主页面里补一份。
- **新结构只做「容器」。** 图、树、画布、新的文档类型等，只负责布局和关系：节点指向已有的会话或文档，点开时嵌入或打开同一个会话组件。不要在节点里自己渲染消息或另存一份对话数据。
- **数据只存一份。** 新功能需要对话数据时，从 child chat 读；要兼容旧字段，就在 store 的读写层统一转换（参考 `#fill` / `#absorb`），不要在界面里两边同步。
- **动手前先搜一下有没有现成的模块。** 消息渲染看 `ui/markdown-dom.mjs` 和 `markdown.mjs`，公式看 `math.mjs`，输入框看 `ui/chat-composer.mjs`，图片查看和标注看 `ui/image-viewer.mjs`（所有图片共用，标注保存走 `image:edit` → `store.structure` 的 `edit-image`），选区和锚点看 `md-document.mjs` 与 `pdf-review.mjs`。能扩展现有模块，就不要另起一份。
- **评审时自查一句：** 「主会话以后再加一个功能，这里会不会自动有？」答案是否，就说明在堆叠，要改成复用。

## 布局：分区一律可拖拽调整

凡是分成几块的界面（左右分栏、上下分区、编辑框和下方会话、侧栏宽度等），都要放分隔条，可以拖动调整大小并记住结果。复用 `ui/splitter.mjs`（HTML 里放 `<div class="splitter is-columns|is-rows">`，在 `app.mjs` 里调用 `splitter(...)`，尺寸通过 CSS 变量传递）。编辑框要随可用空间伸缩，不要写死高度或宽度。

## 数据层

- **消息和批注按行存储，是唯一的原始数据**：
  - `chat_blocks`：每条消息或 block 一行，主键是（会话, ID）。从选中消息新建的会话会沿用原 ID，所以同一个 ID 可能出现在几个会话里。`data` 列存完整内容，其余列（位置、所属消息、类型、发言成员、是否移除、文字）用于查询。
  - `chat_notes`：每条批注一行；`removed=1` 是已删除、还可以撤销的批注。
  - `attachment_uses`：附件被哪个 block 或批注引用。
  - `chat_links`：消息里的 `ownsoft://` 内部链接。
- **会话文档**：`notebook_documents` 只存其余部分（标题、成员、分支、私聊、上下文选择、设置等），一个会话一行 JSON。
- **读写**：`store.read()` 用 `#assemble` 从行和文档拼出完整的会话对象，`store.write()` 用 `#saveRows` 和读出时比对，只写改动过的行。所以 `applyChange` 里的各种修改仍然直接改对象，不用关心存储。两个窗口各改各的消息不会互相覆盖。不要绕过 store 直接写这些表。
- **旧数据**：早期版本把消息存在文档里。启动时，`needsRowMove()` / `moveToRows()` 会先备份（`before-rows`），再迁成行。没迁之前，`#assemble` 也能读旧格式。
- 按 ID 找消息、搜索、跨会话移动都查这些表，不要再逐个解析会话文档。
- **待办**：纯逻辑在 `todos.mjs`（重复规则、下次时间、执行提示词），数据在 `todos` 表（`store.saveTodo / dueTodos / nextTodoDue / finishTodoRun`），每条待办是会话树节点（子会话 `todo:<id>`，开头是来源消息，`#sourceMessage` 实时读取）。定时在 `main.mjs` 的 `scheduleTodos`：只为最近一个到期的设定时器，任何改动后重设，不要改回轮询。执行走普通的 `generate()`，所以模型、成员、MCP 工具都和聊天一致。界面是 `ui/todo-ui.mjs`。模型通过 ownsoft MCP 的 `list_todos / add_todo / update_todo`（`notebook-tools.mjs`）管理待办；MCP 是单独进程直接写库，主进程靠 `PRAGMA data_version` 发现外部写入后会 `scheduleTodos()`，新增写待办的地方不需要另外通知。
- **放大视图是层级的**：`ui/app.mjs` 的 `focusStack` 是一串层（`{ chatId, kind: "note" | "branch", itemId }`），每层左边是 `chatId` 这段会话（mirror 模式嵌入，定位到 `itemId` 的位置），右边是它长出来的子会话。任何地方（包括任意深度的嵌入会话）要打开批注或侧边追问，都调 `focusOn(level)`：嵌入页会转给顶层窗口，来自右边会话就往下一层，来自左边就替换当前层。不要再给嵌入区写单独的打开方式或浮层。
- **批注的会话**：批注也是会话树的节点。它的子会话（`note:<会话>:<批注>`）依次是：原消息（`noteType: "source"`、`virtual: true`，读取时由 `#sourceMessage` 从父会话实时拼出，不存储，`#saveRows` 会跳过它）、批注正文（`noteType: "annotation"` 的笔记块，是批注文字和标记的唯一来源，`#fill` 拉到页边的批注，`#absorb` 把页边的修改推回去）、追问。不要再给批注正文单独实现功能，它就是一条消息。
- **关系**：`child_chats` 是派生关系（父会话 → 批注追问、分支、私聊、审阅对话）。视图 `relations` 把派生、包含、挂载、引用、链接合在一起，用 `store.relationsOf(id)` 查。
- **结构操作**：移动消息、移除和恢复、批注与笔记块互转、删除和恢复批注、消息转批注。纯函数在 `structure.mjs`，通过 `store.structure(op)` 执行：同一事务里保存涉及的会话，把跟着走的追问、分支会话改挂到新会话，并把逆操作记进 `structure_log`（最近 60 条，`store.undoStructure()` 撤销）。新增这类操作时，在 `#structure` 里加一个 case，并给出它的逆操作；界面统一用 `ui/structure-ui.mjs` 的 `apply`，不要直接改 state。

## 开发与测试

- `npm test` 跑全部单元测试。改了数据层，就在对应的 `*.test.mjs` 里补测试。
- 用隔离的实例在应用里验证，不碰用户真实数据：设置 `AI_NOTEBOOK_DATA_DIR=<临时目录>` 和 `AI_NOTEBOOK_FAKE_MODELS=1`（假回答，不消耗额度），再加 `--remote-debugging-port=<端口>`，就可以用 CDP 脚本操作和截图。
- 换行不用管：仓库存 LF，git 的 autocrlf 会在检出时转换，工作区里 CRLF、LF 混着是正常的。
- 用户可见的改动要同步更新 `README.md` 和 `CHANGELOG.md`。

## 待办

### 阶段 3：会话关系的图 / 树视图（已完成，可继续扩展）

已实现：数据在 `store.chatTree(rootId)` / `store.reviewTree(kind, id)`（测试见 `chat-tree.test.mjs`），PDF 的审阅由 `main.mjs` 的 `chat:tree` 按附件哈希补上；界面是 `ui/relation-view.mjs`（顶部「关系图」，替换了原来的分支画布），点节点用 `embedChat` 显示会话。要加新的节点类型，就在 store 的树方法里加，界面只认 `kind`、`open`、`chatId`、`children`。

还可以做的：

- Markdown 文档目前不属于任何会话，所以不会出现在会话的关系图里。可以给 MD 视图和 PDF 审阅也加一个以文档为根的关系图（直接用 `reviewTree`）。
- 原来分支画布可以拖动节点、位置随笔记保存（`move-branch`，store 里还保留着）；现在是自动排布，暂时不能拖。
- 跨会话的总览（所有会话、PDF、文档放在一张图里）。

### 数据层下一步

- 消息和批注已经按行存储。如果以后分支、私聊、上下文选择也需要逐条读写（比如很多分支），按同样的办法拆到表里：在 `#assemble` 里组装，在 `#saveRows` 里比对写入。
- 关系图里只显示有分支的会话结构；会话里消息很多时，可以只加载最近一部分（`chat_blocks` 按位置分页即可）。
- 关系图里拖动节点来调整位置（例如把批注拖到另一条消息上），用的还是 `store.structure`。
- 批注没有「复制 ID」入口，命令行的 `note2block` 只能靠 ID 用；可以补一个，或支持 `.` 指当前放大的批注。
- 跨窗口拖动依赖系统拖放把自定义数据带到另一个窗口；同一窗口内（包括嵌入的会话）已经测过，两个窗口之间还需要在真机上用鼠标试一下。

### 小改进

- 窄面板（MD 侧栏、PDF 侧栏）里，嵌入会话底部的提问输入框占的高度偏多，可以在嵌入模式下压缩。
- 私聊小窗切到完整会话后，窄窗口里消息右上角的操作按钮会折成两行。
