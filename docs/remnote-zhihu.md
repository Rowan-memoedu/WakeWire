# RemNote 知乎文章定时发布

将配置指定的 RemNote Document 中行首单个 `%` 标记的节点及其完整物理子树发布为一篇知乎文章。标记节点自身的可见文字作为文章标题，其下完整物理子树作为正文。用固定 Rem ID 绑定真实 Document，同一 Document 改名不改变发布范围，也不匹配同名普通节点。按文档深度优先顺序处理，不附带父项或兄弟项，不摘要、改写或添加话题。`%%` 暂停整棵子树；父子同时标记时保留原位并报告冲突。「已发布」子树完全排除。

## 发布与恢复

北京时间每天 11:30、17:30、22:30，由 Windows 计划任务 `WakeWire - RemNote Zhihu Articles` 直接运行 `scripts/run-remnote-zhihu.ps1`，再调用本 CLI。调度模式与“一次性命令”一致，复用同一 WakeWire 仓库及本地 MCP；不使用 Codex 自动任务，不依赖模型定时唤起。每个时段最多发布一篇，其余顺延。允许当次任务在 15 分钟内启动；错过窗口不补发，不在恢复开机时集中发布。原命令工作流保留自己的时段与投递规则。

发布前重新核对 Document 身份、登录账号、完整子树及原父节点。提交前将不可自动重放的记录落盘并同步到磁盘；任何超时、结果不明或没有明确文章 ID 的响应都会保留记录、停止后续发布，不能通过再次运行 CLI 重发。需要人工核对后恢复时，先找到实际公开内容；不得删除记录绕过去重。

取得 ID 后回读 `https://zhuanlan.zhihu.com/p/<id>` 对应的 API 内容，核对 ID、作者、标题、全部可见文字、列表层级、强调、链接目标和指定专栏的已接受归属，之后才将原 Rem 节点及完整子树移动到 Document 的「已发布」下。移动完成并回读后去掉根节点 `%`；保留原 Rem ID、子节点、内部引用和结构。源内容在发布后被用户修改或移动时停止归档，不覆盖用户改动。回执保留公开 URL。归档失败时再次运行只补做已验证内容的归档；已知 ID 的发布结果可以继续只读核验，结果未知则停止。

文章保留多行文字、Markdown 强调、链接和真实嵌套列表。空叶节点在正文内容组之间转为空段落分隔，不生成空项目符号；同级内容组首尾的空编辑占位不输出，内部连续空节点保留各自间隔。节点内单换行转为 `<br>`，连续换行保留相应行距，不能依赖 HTML 中会折叠的普通换行。带子树的空容器保留子树层级但不生成空项目符号。回读按可见列表深度、空段落位置、节点内换行及强调/链接所在文字位置核验，允许知乎将子列表移到父 `li` 外侧和将 `strong` 转为 `b`，不把等效 DOM 变化误判为内容变化；原始 HTML 作为文字转义，不允许脚本执行。Rem 内部引用只输出可见文字，不跟随读取引用目标。媒体、portal、未解析引用和重叠标记保留原位并报告，不以漏内容的版本发布。标题必填、禁止换行、最多 100 字；正文必填、9～100,000 字。超限时停止，不自动删减、补写或拆分。相同标题与可见正文的重复来源也会被拦截。

正文转换完成后，在全部列表之外统一追加恰好一个空段落，作为文章末尾的一行空行。该尾部空行也纳入云端回读校验；原稿末尾的空编辑占位不会累加成多行。

## 客户端与凭据

已核验官方 `zhihu-cli` 0.6.1 的 `capabilities`，该版本没有文章发布命令。官方发布 Skill 是另一条 OpenAPI 路线，需要独立发布凭据，不能把官方 CLI 的 Access Secret 擅自视为发布授权。

本流程调用维护中的 [BAIGUANGMEI/zhihu-cli](https://github.com/BAIGUANGMEI/zhihu-cli) 的 `ZhihuClient`（PyPI 包 `pyzhihu-cli==0.2.4`），复用其创建文章、CSRF 及 API 处理。发布前检查配置专栏的管理权限，并仅在原客户端的文章发布请求中设置该专栏；发布后必须回读到同一专栏的 `accepted` 归属。文章已发布但专栏尚未接受时保留文章 ID，不重复发文或提前归档。安装到本机独立 Python 环境：

```powershell
python -m venv <runtime-directory>
<runtime-python> -m pip install -r scripts/zhihu-requirements.txt
```

客户端适配器每次读取现有 Chrome Cookie 同步快照，只向 `https://www.zhihu.com` 与 `https://zhuanlan.zhihu.com` 发送匹配域名、路径和有效期的 Cookie，禁止重定向，不复制或另存 Cookie。超过 15 分钟未同步、退出账号、账号与配置不符时停止。日志不打印 Cookie、请求头、远端响应正文或源笔记正文。

## 本机配置与命令

真实 Document ID、账户 ID、Cookie 快照、Python 环境及回执只保存在本机应用数据目录，不进入 Git。配置示例：

```json
{
  "documentRemId": "<exact-document-id>",
  "documentTitle": "<display-name-only>",
  "mcpUrl": "http://127.0.0.1:<port>/mcp",
  "python": "<absolute-runtime-python>",
  "cookieSnapshot": "<existing-local-chrome-cookie-snapshot>",
  "accountId": "<verified-zhihu-account-id>",
  "columnId": "<verified-managed-column-token>",
  "seriesStartDate": "<YYYY-MM-DD-in-Shanghai>"
}
```

```powershell
node dist/workflows/remnote-zhihu-cli.js check <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js scan <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js preview <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js draft <absolute-config.json> <source-rem-id>
node dist/workflows/remnote-zhihu-cli.js approve-draft <absolute-config.json> <source-rem-id>
node dist/workflows/remnote-zhihu-cli.js run <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js adopt <absolute-config.json> <source-rem-id> <published-article-id>
pwsh -NoLogo -NoProfile -File scripts/install-remnote-zhihu-task.ps1 -Config <absolute-config.json>
```

`check` 为只读扫描及登录核验；`scan` 只读计数；`preview` 将第一篇待发布内容转换为本地 HTML，不触碰知乎草稿或修改 RemNote。`draft` 使用真实知乎登录态创建并保存云端草稿，回读标题、全文与布局，返回真实编辑器链接；重复运行更新同一草稿，不另建副本。草稿结果不明时保留记录，禁止自动重建。云端已被作者修改时停止并保留改动。草稿对应的来源保留在 RemNote 原位，处于待验收状态时定时扫描跳过该来源，其余内容仍按序处理。只有用户明确认可后才执行 `approve-draft`，将该草稿恢复为可发布；此命令本身不发布。正式 `run` 复用已认可草稿的同一 ID，发布前重新核对源内容、云端内容及当日标题，不覆盖作者后续改动。

配置 `seriesStartDate` 时，云端草稿和正式文章标题追加 `（第N 篇 | day D）`。篇数按专栏已发表文章数、专栏现存标题最大篇号与本地已发表回执最大篇号的最大值递增；草稿不占正式篇数。day 按上海时区从配置起始日期计算自然日，起始日为 day 1；同一天多篇共用 day 数。实际发布前重新计算，草稿中的编号只是当时预览。标题长度包含后缀，超过 100 字即停止。

只有 `run` 会在指定窗口发布，窗口外仅恢复已有记录。`adopt` 用于用户明确指出已手动发布的文章：核对完整正文、可见布局、作者与专栏后，登记实际公开标题和 URL，将原子树归档；它不会新建或修改任何知乎文章。保存过的草稿若由用户手动发布，后续运行按同样条件核验并归档，不再发一次。已有回执冲突或对照不符时停止，不靠移除 `%` 隐藏问题。配置目录保存 `state.json`、`last-run.json`、`preview.html` 和 `preview.json`。运行使用进程排他锁，死进程残留锁可恢复，活进程持锁时拒绝并行。

转换器直接输出知乎原生的列表表示：子列表放在已闭合的父 `li` 之后。标准 HTML 的 `<li>父项<ul>子项</ul></li>` 虽然网页显示正常，但知乎编辑器导入时会在父项闭合处额外插入空段落，不能作为发布输入。API 回读中的文字和语义列表一致也不足以证明编辑器导入一致；真实验收需将编辑器渲染后的内容块逐一对照源节点，比较空行数量与位置、项目深度、文字及节点内换行。

任务以当前登录用户的 Limited 权限隐藏运行，禁止重叠实例，保留实际 Node 子流程的退出码。失败最多间隔 5 分钟重试两次；CLI 的窗口限制和已落盘回执仍约束每次重试，不会再次提交未知结果。注册任务不会立即执行发布。需 Windows 用户已登录、RemNote MCP 在线及现有 Chrome 登录态同步可用；不依赖 ChatGPT 桌面端中的 Codex 保持开启。暂停时停用该 Windows 计划任务，保留本机回执。恢复连接沿用已有 RemNote MCP 启动入口，不重启 RemNote 或用户正在使用的应用。不得通过删除未知结果记录、临时另发、扩大到其他 Document 或补发错过时段绕过限制。

## 验证

```powershell
npm run typecheck
npm test
npm run lint
npm run build
<runtime-python> scripts/test_zhihu_client.py
```

隔离测试覆盖正文边界、按序单条发布、时区与窗口、重叠标记、登录失效、账号切换、源编辑、先落盘后提交、未知结果防重放、发布回读不符、移动/去标记中断恢复及独立格式样本。真实登录、目标 Document 和只读预览通过，不代表已完成一次真实发布归档；首次正式时段应根据公开 URL、回执和原 Rem 父链核验。
