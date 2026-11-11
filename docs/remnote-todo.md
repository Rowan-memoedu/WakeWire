# RemNote 待办定时分发

Windows 计划任务 `WakeWire - RemNote Todo 0200` 每天北京时间 02:00、11:00、17:00 直接运行 `scripts/run-remnote-todo.ps1`。任务名称保留以沿用现有入口。脚本通过本地 RemNote MCP 扫描配置子树，将行首单个 `%` 标记事项的原文投放给 WakeWire。`%%` 和未标记事项保留原位。

普通入口绑定「一次性命令」的固定 Document ID，不再读取原 `to do list`。配置 `maintenanceDocumentsFile` 后，同一进程同时扫描维护根下明确配置的 Document；所有入口复用同一个扫描、原文导出、去重、投递和受理归位实现，共享同一路由的四路并发。维护类的对象范围及工程收尾要求通过原生 `thread/start.developerInstructions` 单独传入，普通命令不设置该字段，用户消息仍为原文。绑定见 [项目维护](remnote-maintenance.md)。

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
node <installed-dist>/workflows/remnote-todo-cli.js scan <absolute-config.json>
```

`setup` 和 `check` 核验本机配置与服务版本，`check` 另核验各入口的 Document 身份及维护根父链。`scan` 只读扫描并输出计数和原文哈希，不投递、不移动、不创建归位节点；`run` 或 Windows 计划触发时才消费标记。

Windows 用户须登录，WakeWire 和本地 RemNote 桥接须可用。Project 归属需要 ChatGPT 桌面端中的 Codex 正在运行。扫描结果存储在配置目录的 `last-run.json`。

计划任务直接以隐藏窗口运行 PowerShell，保留子流程的非零退出码，不能用 `conhost --headless` 的退出码代替工作流结果。新配置下只运行统一入口；旧 `maintenanceConfigFile` 执行逻辑仅供尚未迁移的配置兼容。读取失败会记录具体方法及节点 ID，一份 Document 出错不阻止其他来源扫描；未知投递不会自动重放。报告包含每份 Document 的扫描结果和被旧投递记录抑制的事项。`legacyReceipts` 保存旧 Document/route 身份，用于迁移去重，失败或未知的旧记录也不会自动重投。

所有入口跳过各自的「已完成」子树。新维护 Document 缺少「已开始」时，仅在首轮受理后创建并回读，再沿用原归位规则；不自动标记任务完成。源码实现与提示词位于 `src/workflows/remnote-command-sources.ts`。配置中的真实标题、节点身份、源码路径和任务正文只存本机，不进入仓库。

维护入口按 Document 成批，序号及混合标记规则见 [项目维护](remnote-maintenance.md)。`remnote-command-batch.ts` 只组织批次与受理后的编号前移，原文导出和原节点归位继续共用本实现。待恢复批次保存在原 deliveries 记录的本机元数据中；普通命令不携带批次计划。

本地路由使用 `promptMode: verbatim`、`sandbox: user-config` 和 `projectPlacement: after-turn`。私有 App Server 采用本机的权限配置。保存的 `appOwnerThreadId` 供桌面工具在首轮结束后办理归属，投放可由独立进程发起。

需要暂停时停用 Windows 计划和对应路由。保留投递记录用于去重与恢复。
