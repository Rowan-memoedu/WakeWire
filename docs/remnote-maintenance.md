# RemNote 项目维护

使用已绑定维护根文档下的项目 Document，将固定 Document ID 与 `owner/repository` 一对一绑定。根节点由配置的 `legacyDocumentRemId` 指定，字段保留历史名称；移动整个维护区后须按实际父链更新此绑定，不把 Document 移回旧目录。配置位于 `D:/AppData/WakeWire/workflows/remnote-maintenance/config.json`，不进入 Git。

每天北京时间 02:00、11:00、17:00 的既有待办计划先投放项目维护，再处理普通待办。普通待办通过其 `maintenanceConfigFile` 字段排除绑定子树。行首单个 `%` 标记、原文导出、父项背景、重叠标记拒绝规则均复用原工作流；“已完成”子树不再消费。

当前配置使用 `execution: native`：维护模块在原有 deliveries 表记录任务，再复用普通待办的已认证原文投放入口、私有 Codex App Server 和 `sandbox: user-config`。首轮结束、私有会话释放后，WakeWire 通过桌面原生工具将既有 Thread 归入保存的 local Project，维护流程不设置模型、推理强度或额外权限，不增加离线、单仓库及工具白名单限制。绑定仓库为入口项目，必要的关联仓库也可处理。业务原文完整保留，前后仅补充入口仓库位置和 PR 交付方法。普通待办自身的原文规则不变。

原生 Thread 将各仓库候选提交推送到同一请求对应的 `codex/maintenance-<request-id>` 分支，通过 `native-maintenance-cli submit` 发起 `native-maintenance.yml` 的独立检查。命令等待并返回检查结果，原 Thread 可据此继续修复、再次提交；检查通过后 Actions 创建或复用 PR。`finalize` 明确本次相关仓库的 PR 集合已经齐备。模型执行与会话历史仍由原生 Codex 管理，没有新的 Agent 队列或会话数据库。普通待办已有投放记录、旧 Actions 记录和未知结果均保留；重复扫描不另建 Thread，不盲目重发 GitHub mutation。

原生提交接受维护账号已有的公开或私有仓库，用于同一任务中的源码与公开前端更新。仓库必须未归档且仍属于该账号；GitHub 重定向后的归属、精确提交、独立检查和 PR 身份均继续核验。此入口不改变仓库可见性，也不扩展旧 CLI 路线的私有源码范围。

入口预检同样区分执行方式：`native` 允许已绑定的同账号公开或私有源码仓库；维护中心仓库和旧 `actions` 路线继续要求私有。文档层级和仓库属性分别核验，不能把历史私有仓库限制重新套到原生入口。

原生 Thread 首轮受理后移动原 Rem 及子树到“已开始”，回读后移除 `%`。执行进度和 Actions/PR 身份保存在 WakeWire 投递记录中。RemNote 只移动原事项及其子树，并在受理时移除派发标记。GitHub Actions 状态工作流在维护或检查结束后与每 15 分钟核对已投放请求，不读取新命令。只有完整 PR 集合已确认、每个仓库最新提交均通过检查、对应精确 head 的 PR 全部合并到目标默认分支时才归档。任务正文及子树在执行期间有改动时保留“已开始”，避免把新增需求当作完成。

命令：

```powershell
node <installed-dist>/workflows/remnote-maintenance-cli.js setup <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js check <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js scan <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js run <absolute-config.json>
node <installed-dist>/workflows/remnote-maintenance-cli.js reconcile <absolute-config.json>
```

`setup` 建立映射和两个归位节点，但不投放；`check` 核验版本、映射、仓库和文档；`scan` 只查看标记数量；只有 `run` 消费标记。`reconcile` 核对已登记请求，不读取新命令。Actions 自带令牌只读取维护仓库的运行状态，GitHub App 令牌只读取绑定及关联仓库的代码与 PR；不扩大现有 App 权限。

`native` 配置复用普通待办的 `cwd`、`appProjectId` 和 `routeId`；每个 binding 保存入口仓库的 `localPath`。业务投放直接启动 App Server。保存的 `appOwnerThreadId` 只用于桌面原生工具，登记 Project 时无需活动的调用者回合。配置与 `native-requests` 都留在本机。Actions 状态令牌按实际关联仓库扩大其只读仓库集合，不增加 App 的权限种类。

`retry-native <config> <task-rem-id>...` 只用于明确指定的旧失败任务：先核验旧运行已经 failure、没有 PR、正文未变，再切换为原生执行。旧 run ID 不覆盖。没有旧运行身份、结果未知或可能已发布的任务不会自动重投。`execution: actions` 保留旧流程兼容，不作为 native 失败时的替代执行路线。

暂停某个映射时禁用对应 WakeWire route，并保留配置中的排除项与投放记录。恢复原版本时保留新增 receipt 列和映射数据，不删除去重记录；若取消项目分流，先核对未完成请求再移除普通待办的排除配置。
