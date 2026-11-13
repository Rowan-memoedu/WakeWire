# RemNote 知乎文章定时发布

将固定的「知乎想法」Document 中行首单个 `%` 标记的节点及其完整物理子树发布为一篇知乎文章。标记节点自身的可见文字作为文章标题，其下完整物理子树作为正文。来源 Document 保持原名称，不改名。按文档深度优先顺序处理，不附带父项或兄弟项，不摘要、改写或添加话题。`%%` 暂停整棵子树；父子同时标记时保留原位并报告冲突。「已发布」子树完全排除。

## 发布与恢复

北京时间每天 11:30、17:30、22:30，由原生 Codex 自动任务触发本 CLI。每个时段最多发布一篇，其余顺延。允许当次任务在 15 分钟内启动；错过窗口不补发，不在恢复开机时集中发布。CLI 不安装另一个 Windows 周期任务，不新建 Codex Thread，也不经过原命令投递路由。

发布前重新核对 Document 身份、登录账号、完整子树及原父节点。提交前将不可自动重放的记录落盘并同步到磁盘；任何超时、结果不明或没有明确文章 ID 的响应都会保留记录、停止后续发布，不能通过再次运行 CLI 重发。需要人工核对后恢复时，先找到实际公开内容；不得删除记录绕过去重。

取得 ID 后回读 `https://zhuanlan.zhihu.com/p/<id>` 对应的 API 内容，核对 ID、作者、标题、全部可见文字、列表层级、强调和链接目标，之后才将原 Rem 节点及完整子树移动到 Document 的「已发布」下。移动完成并回读后去掉根节点 `%`；保留原 Rem ID、子节点、内部引用和结构。源内容在发布后被用户修改或移动时停止归档，不覆盖用户改动。回执保留公开 URL。归档失败时再次运行只补做已验证内容的归档；已知 ID 的发布结果可以继续只读核验，结果未知则停止。

文章保留多行文字、Markdown 强调、链接和真实嵌套列表；原始 HTML 作为文字转义，不允许脚本执行。Rem 内部引用只输出可见文字，不跟随读取引用目标。媒体、portal、未解析引用和重叠标记保留原位并报告，不以漏内容的版本发布。标题必填、禁止换行、最多 100 字；正文必填、9～100,000 字。超限时停止，不自动删减、补写或拆分。相同标题与可见正文的重复来源也会被拦截。

## 客户端与凭据

已核验官方 `zhihu-cli` 0.6.1 的 `capabilities`，该版本没有文章发布命令。官方发布 Skill 是另一条 OpenAPI 路线，需要独立发布凭据，不能把官方 CLI 的 Access Secret 擅自视为发布授权。

本流程调用维护中的 [BAIGUANGMEI/zhihu-cli](https://github.com/BAIGUANGMEI/zhihu-cli) 的 `ZhihuClient`（PyPI 包 `pyzhihu-cli==0.2.4`），复用其创建文章、CSRF 及 API 处理。安装到本机独立 Python 环境：

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
  "mcpUrl": "http://127.0.0.1:<port>/mcp",
  "python": "<absolute-runtime-python>",
  "cookieSnapshot": "<existing-local-chrome-cookie-snapshot>",
  "accountId": "<verified-zhihu-account-id>"
}
```

```powershell
node dist/workflows/remnote-zhihu-cli.js check <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js scan <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js preview <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js run <absolute-config.json>
```

`check` 为只读扫描及登录核验；`scan` 只读计数；`preview` 将第一篇待发布内容转换为本地 HTML，不触碰知乎草稿或修改 RemNote；只有 `run` 会在指定窗口发布及归档，窗口外仅补做已有记录的恢复。配置目录保存 `state.json`、`last-run.json`、`preview.html` 和 `preview.json`。运行使用进程排他锁，死进程残留锁可恢复，活进程持锁时拒绝并行。

原生自动任务应只执行已安装的本 CLI，不让模型改写正文、改用网页点击、删除未知结果记录、临时另发、扩大到其他 Document 或补发错过的时段。暂停使用原生自动任务的暂停能力；保留本机回执。恢复连接沿用已有 RemNote MCP 启动入口，不重启 RemNote 或用户正在使用的应用。

## 验证

```powershell
npm run typecheck
npm test
npm run lint
npm run build
<runtime-python> scripts/test_zhihu_client.py
```

隔离测试覆盖正文边界、按序单条发布、时区与窗口、重叠标记、登录失效、账号切换、源编辑、先落盘后提交、未知结果防重放、发布回读不符、移动/去标记中断恢复及独立格式样本。真实登录、目标 Document 和只读预览通过，不代表已完成一次真实发布归档；首次正式时段应根据公开 URL、回执和原 Rem 父链核验。
