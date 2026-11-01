# RemNote 项目维护

使用现有 To Do List 中的项目 Document，将固定 Document ID 与 `owner/repository` 一对一绑定。配置位于 `D:/AppData/WakeWire/workflows/remnote-maintenance/config.json`，不进入 Git。

每天北京时间 02:00 的既有待办计划先投放项目维护，再处理普通待办。普通待办通过其 `maintenanceConfigFile` 字段排除绑定子树。行首单个 `%` 标记、原文导出、父项背景、重叠标记拒绝规则均复用原工作流；“已完成”子树不再消费。

维护模块通过 WakeWire 已认证本地 API 原子记录发送意图，再调用官方 GitHub workflow dispatch，使用 `return_run_details: true` 取得准确 run ID。身份保存在原有 deliveries 表，既不创建 Codex 桌面 Thread，也不进入 Codex 队列。GitHub Actions 负责排队、隔离检出、现有 Codex CLI 订阅执行和草稿 PR。重复扫描不重复投放；HTTP 超时、掉线或进程退出后的未知结果保留原记录，禁止自动重发。

GitHub 受理后移动原 Rem 及子树到“已开始”，回读后移除 `%`。每项附一个执行进度节点及 Actions/PR 链接。GitHub Actions 的状态工作流在维护结束后与每 15 分钟核对已投放请求，不读取新命令。只有成功运行的精确结果报告、匹配仓库/分支/PR、相同 head SHA 已合并到目标默认分支时才归档。任务正文及子树在执行期间有改动时保留“已开始”，避免把新增需求当作完成。

命令：

```powershell
node <installed-dist>/workflows/remnote-maintenance-cli.js setup <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js check <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js scan <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js run <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js reconcile <absolute-config.json>
```

`setup` 建立映射和两个归位节点，但不投放；`check` 核验版本、映射、仓库和文档；`scan` 只查看标记数量；只有 `run` 消费标记。`reconcile` 只核对旧运行。Actions 自带令牌只读取维护仓库的运行状态，GitHub App 令牌只读取绑定仓库的代码与 PR；不扩大现有 App 权限。

暂停某个映射时禁用对应 WakeWire route，并保留配置中的排除项与投放记录。恢复原版本时保留新增 receipt 列和映射数据，不删除去重记录；若取消项目分流，先核对未完成请求再移除普通待办的排除配置。
