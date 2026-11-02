# RemNote 待办定时分发

Windows 计划任务 `WakeWire - RemNote Todo 0200` 每天北京时间 02:00 直接运行 `scripts/run-remnote-todo.ps1`。脚本通过本地 RemNote MCP 扫描配置子树，将行首单个 `%` 标记事项的原文投放给 WakeWire。`%%` 和未标记事项保留原位。

配置 `maintenanceConfigFile` 后，同一计划先投放已绑定项目的 GitHub Actions 维护请求；普通待办扫描排除该配置列出的 Document 子树。绑定和 PR 合并归档见 [项目维护](remnote-maintenance.md)。普通待办的原生 Thread 行为保持原有语义。

本工作流设置 `target.maxConcurrent: 4`，最多并行运行四个独立 Thread；有空位即接收下一项，无需等待其他 Thread 的首轮完成。投放按扫描顺序发起，归位按原任务顺序等待受理确认。单个已有 Thread 的多条投递仍串行，其他未配置并发的路由保持原行为。

WakeWire 为每个新事项启动私有 Codex App Server，在配置的 `cwd` 创建 Thread。首轮受理即可移动原 Rem 到“已开始”。首轮结束后释放该 App Server，后台通过官方 app-tools 载入已有 Thread，移动到 `appProjectId` 指定的 Project，并核对 Thread ID、Project 和工作目录。载入会切换桌面主窗口。若应用暂不可用，补做归属时沿用已保存的投递和 Thread 身份。

母项上标记 `%`：直接投放该项及完整子树的原文。子项上标记 `%`：投放直接母项及其全部后代，只在前面增加一句“本次任务是下文母项的第 N 个子项及其下属内容，其他部分仅作背景。”已开始母项下的新 `%` 子项仍创建独立 Thread。

导出保留原句、顺序、层级、换行、公式和定义；只去掉目标项的派发符号，引用转换成可见文字，空白叶节点不计入子项序号。不摘要、不重写、不增加执行规则。新 Thread 的用户消息不包含调度程序添加的 RemNote 说明、节点 ID、MCP 读取要求、事件信封或 JSON 元数据，也不负责回源读取。具体业务原文本身若提及 RemNote，则照常保留。

WakeWire 在应用返回 Thread ID、确认首轮已受理后立即保存原生 ID。扫描器将事项的原节点及全部后代按原清单顺序追加到文档已有的“已开始”节点下，每项上下都有空节点，相邻事项共用一个空节点。移动和空行就位后才删去 `%`，并回读父节点、标题和引用；不添加“已开始：”前缀。旧前缀事项迁移时仅去掉前缀并移动原子树。Thread 历史仍由 Codex 管理；稳定事件 ID 保持不变，移动或标题回写失败后安全续做，不另建 Thread。未知投递结果保留记录并停止自动重放。

标题更新保留 Markdown 格式、精确 Rem 引用、节点 ID 和子树。含标题图片或无法唯一还原的同名引用时保留原标题并记录错误，避免损坏。父子同时标记 `%` 时保留冲突标记，不猜测重叠执行范围。

## 安装和检查

配置仅存本机活动数据目录，不进入 Git。字段为 `documentRemId`、`cwd`、`mcpUrl`、`wakewireHome`、`provider`；`setup` 补充或沿用 `routeId`。MCP 地址必须是回环地址。本地投放使用 WakeWire 管理接口现有认证，不通过限制字段长度的 webhook 映射。旧的 webhook source 在升级时禁用，投递历史和原 Thread 全部保留。

```powershell
node <installed-dist>/workflows/remnote-todo-cli.js setup <absolute-config.json>
node <installed-dist>/workflows/remnote-todo-cli.js check <absolute-config.json>
```

`setup` 和 `check` 核验本机配置与服务版本。`run` 或 Windows 计划触发时才消费标记。

Windows 用户须登录，WakeWire 和本地 RemNote 桥接须可用。Project 归属需要 ChatGPT 桌面端中的 Codex 正在运行。扫描结果存储在配置目录的 `last-run.json`。

本地路由使用 `promptMode: verbatim`、`sandbox: user-config` 和 `projectPlacement: after-turn`。私有 App Server 采用本机的权限配置。保存的 `appOwnerThreadId` 供桌面工具在首轮结束后办理归属，投放可由独立进程发起。

需要暂停时停用 Windows 计划和对应路由。保留投递记录用于去重与恢复。
