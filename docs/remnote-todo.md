# RemNote 待办定时分发

Windows 计划任务每天北京时间 02:00 调用本流程。它完整扫描配置的 RemNote 子树，将行首单个 `%` 标记的事项交给 WakeWire 的签名 webhook，再由 WakeWire 创建独立的真实 Codex Thread。`%%` 和未标记事项均不分发。

顶层任务以自身完整子树为上下文。嵌套任务以直接母项和母项全部后代为上下文，但只有标记项及其后代定义执行范围，兄弟项只是已处理事项的背景。已开始的母项下新增 `%` 子项时，新建独立 Thread。首轮直接推进条件明确的工作，真实未决事项才讨论。

WakeWire 收到 `thread/start` 和 `turn/start` 的确认后立即保存原生 ID，扫描器才将 `%` 改为 `已开始：` 并回读。Thread 历史仍由 Codex 管理；本流程只复用 WakeWire 已有投递记录，不维护第二套 Thread 数据库。稳定事件 ID 以清单和任务 Rem ID 计算，首次运行也包括现存标记。重复扫描和回写失败不会另建 Thread；未知投递结果保留记录并停止自动重放。

标题更新保留 Markdown 格式、精确 Rem 引用、节点 ID 和子树。含标题图片或无法唯一还原的同名引用时保留原标题并记录错误，避免损坏。父子同时标记 `%` 时保留冲突标记，不猜测重叠执行范围。

## 安装和检查

配置仅存本机活动数据目录，不进入 Git。字段为 `documentRemId`、`cwd`、`mcpUrl`、`wakewireHome`、`provider`；`setup` 补充 `sourceId`、`routeId`。MCP 地址必须是回环地址。签名密钥仍保留在 WakeWire 密钥存储中，不写入流程配置。

```powershell
node <installed-dist>/workflows/remnote-todo-cli.js setup <absolute-config.json>
node <installed-dist>/workflows/remnote-todo-cli.js check <absolute-config.json>
pwsh -NoProfile -File <installed-scripts>/install-remnote-todo-task.ps1 -Config <absolute-config.json>
```

`setup` 和 `check` 均不读取清单内容、不发起任务；安装计划任务也不会立即运行。只有 `run` 或计划触发才消费标记。检查结果必须显示已安装版本与运行中的 daemon 一致。

需要用户登录 Windows、WakeWire 后台正常运行、RemNote 桥接已连接。计划任务尝试唤醒睡眠中的计算机，错过时间时在可用后补跑；关机期间不能执行。错误和确认结果保存在配置目录的 `last-run.json`，计划进程的退出码为非零表示需要检查；输入内容不会写入日志。

本流程的受信任本地 webhook 路由显式使用 `sandbox: user-config`，让 App Server 沿用用户已有 Codex 权限配置和模型，不覆盖成默认只读。其他路由仍沿用各自沙盒，邮件仍强制只读。该模式仅支持 `codex-app-server`。

暂停流程：禁用 `WakeWire - RemNote Todo 0200` 计划任务及对应 WakeWire route。不要删除投递历史，否则会丢失去重依据。不要手工 replay 未知结果或已确认受理的记录；先检查已有 Thread。
