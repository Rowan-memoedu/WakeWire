# RemNote 待办定时分发

Windows 计划任务每天北京时间 02:00 调用本流程。调度程序通过本地 RemNote MCP 完整扫描配置子树，机械提取行首单个 `%` 标记事项的原文，通过 WakeWire 经过认证的本地接口投放，再由 WakeWire 创建独立的真实 Codex Thread。`%%` 和未标记事项均不分发。

母项上标记 `%`：直接投放该项及完整子树的原文。子项上标记 `%`：投放直接母项及其全部后代，只在前面增加一句“本次任务是下文母项的第 N 个子项及其下属内容，其他部分仅作背景。”已开始母项下的新 `%` 子项仍创建独立 Thread。

导出保留原句、顺序、层级、换行、公式和定义；只去掉目标项的派发符号，引用转换成可见文字，空白叶节点不计入子项序号。不摘要、不重写、不增加执行规则。新 Thread 的用户消息不包含调度程序添加的 RemNote 说明、节点 ID、MCP 读取要求、事件信封或 JSON 元数据，也不负责回源读取。具体业务原文本身若提及 RemNote，则照常保留。

WakeWire 收到 `thread/start` 和 `turn/start` 的确认后立即保存原生 ID，扫描器才将 `%` 改为 `已开始：` 并回读。Thread 历史仍由 Codex 管理；本流程只复用 WakeWire 已有投递记录，不维护第二套 Thread 数据库。稳定事件 ID 以清单和任务 Rem ID 计算，首次运行也包括现存标记。重复扫描和回写失败不会另建 Thread；未知投递结果保留记录并停止自动重放。

标题更新保留 Markdown 格式、精确 Rem 引用、节点 ID 和子树。含标题图片或无法唯一还原的同名引用时保留原标题并记录错误，避免损坏。父子同时标记 `%` 时保留冲突标记，不猜测重叠执行范围。

## 安装和检查

配置仅存本机活动数据目录，不进入 Git。字段为 `documentRemId`、`cwd`、`mcpUrl`、`wakewireHome`、`provider`；`setup` 补充或沿用 `routeId`。MCP 地址必须是回环地址。本地投放使用 WakeWire 管理接口现有认证，不通过限制字段长度的 webhook 映射。旧的 webhook source 在升级时禁用，投递历史和原 Thread 全部保留。

```powershell
node <installed-dist>/workflows/remnote-todo-cli.js setup <absolute-config.json>
node <installed-dist>/workflows/remnote-todo-cli.js check <absolute-config.json>
pwsh -NoProfile -File <installed-scripts>/install-remnote-todo-task.ps1 -Config <absolute-config.json>
```

`setup` 和 `check` 均不读取清单内容、不发起任务；安装计划任务也不会立即运行。只有 `run` 或计划触发才消费标记。检查结果必须显示已安装版本与运行中的 daemon 一致。

需要用户登录 Windows、WakeWire 后台正常运行、RemNote 桥接已连接。计划任务尝试唤醒睡眠中的计算机，错过时间时在可用后补跑；关机期间不能执行。错误和确认结果保存在配置目录的 `last-run.json`，计划进程的退出码为非零表示需要检查；输入内容不会写入日志。

本流程的本地路由显式使用 `target.promptMode: verbatim` 和 `sandbox: user-config`，将完整原文作为原生用户消息发送，让 App Server 沿用用户已有 Codex 权限配置和模型。事件入口不能向此路由投递；其他路由仍使用原有模板和事件信封，邮件仍强制只读。该工作流使用 `codex-app-server`。

暂停流程：禁用 `WakeWire - RemNote Todo 0200` 计划任务及对应 WakeWire route。不要删除投递历史，否则会丢失去重依据。不要手工 replay 未知结果或已确认受理的记录；先检查已有 Thread。
