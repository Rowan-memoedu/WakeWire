# Contributing

# 协作开发

本项目由 `memoedu/developers` 协作维护，成员拥有仓库 Admin 权限。每人和各自 Agent 使用本人的 GitHub 身份；仓库权限不包含服务器、云账号、私人知识库或生产数据权限。

## 开发与合并

1. 阅读 README 与 AGENTS.md，确认当前分支、远端地址和未提交改动。使用本任务自己的分支；保留其他任务的改动，不把工作目录中所有文件一次性提交。
2. 开始前获取远端最新状态，从最新主分支建立 `feat/<主题>`、`fix/<主题>` 或 `docs/<主题>` 分支。依赖安装和测试使用 README 中的项目命令。
3. 按明确路径暂存文件；提交前检查 `git diff --cached`、`git diff --cached --check`，并扫描凭据。不得提交真实账号、Cookie、Token、邀请码、学习进度、私人材料、数据库、日志或个人运行配置。配置只提交不含秘密的示例。
4. 运行与修改相应的检查，再提交并推送当前任务分支，创建 PR。PR 写清行为变化、验证结果和未通过项；未经验证的功能不写成已通过。文档修改做链接和差异检查，不冒充功能验收。
5. 合并前获取目标主分支的新提交。出现冲突时保留双方内容并重新测试；不对共享分支强制推送，不使用 reset --hard 或 checkout -- 丢弃他人改动。
6. PR 合并后，各开发目录执行 `git fetch origin` 并在工作区安全时 `git pull --ff-only`；有本地改动时先在自己的分支保存。核对主分支与 `origin/main`，避免把旧版本重新发布。

## 运行与数据

开发环境按 README 从源码独立安装，使用各自的凭据和隔离测试数据。文档中的原作者路径和本机状态不是协作者的运行配置，也不构成操作原作者设备或账户的授权。禁止把作者的现成虚拟环境、登录态或生产数据库打包共享。

涉及跨仓库依赖时，记录依赖仓库及兼容版本，修改双方后分别提交并说明合并顺序。构建不等于发布；生产发布使用已验证的明确提交，并执行健康检查和项目规定的恢复步骤。

GitHub Free 的私有仓库当前不能强制受保护分支；上述 PR 流程仍须遵守。若升级套餐，可将审查和测试要求配置为 GitHub 强制规则。

## 本项目检查

安装、依赖版本、启动与测试入口以本仓库 README 和已有 AGENTS.md 为准。开始修改前先运行与任务有关的基线检查。需要真实凭据、生产数据或原作者设备的步骤，必须由各自的环境单独配置，不能从本仓库推断已取得访问权。


## Dev setup

```bash
npm install
npm run typecheck
npm test               # vitest; coverage: npm run test:coverage
npm run lint           # biome
npm run build          # tsc → dist/
```

Node ≥ 20.18. No end-to-end Codex tests run in CI (CI can't assume a logged-in
codex install) — the sink is mocked in unit tests, and the real path is covered by
the manual smoke test below. Run it before cutting a release.

## Manual smoke test (~10 minutes, needs codex installed + logged in)

1. **Init & start**
   ```bash
   WAKEWIRE_HOME=$(mktemp -d) ; export WAKEWIRE_HOME
   node dist/cli.js init
   node dist/cli.js start &      # foreground daemon in the background of this shell
   node dist/cli.js status       # expect adapter.codexReachable: true
   ```
2. **M1 — injection.** Create a target thread and inject:
   ```bash
   codex exec --skip-git-repo-check "say READY and stop" --json | grep thread.started
   ./scripts/demo/m1-inject.sh <threadId> "hello from wakewire"
   codex resume <threadId>   # verify both turns are there
   ```
3. **M2 — webhook path.** Create a listen-mode source + route (see header of
   `scripts/demo/m2-github-push.sh`), then:
   ```bash
   ./scripts/demo/m2-github-push.sh <sourceId> <secret> demo-1
   ./scripts/demo/m2-github-push.sh <sourceId> <secret> demo-1   # duplicate → skipped-duplicate
   ```
   Check `GET /api/deliveries`: first `delivered`, second `skipped-duplicate`.
   With a real repo webhook (smee mode), a push should land within ~10 seconds.
4. **M3 — plugin.** Follow `scripts/demo/m3-plugin.md` from a fresh Codex session.
5. **M4 — gmail.** Follow `scripts/demo/m4-gmail.md`; a labeled email should land
   within ~30 seconds; verify an HTML-only email renders readably.
6. **Resilience.** Quit the Codex app / revoke network, send an event, confirm the
   delivery goes `held` and delivers after recovery; `kill -9` the daemon
   mid-delivery and restart — the delivery must not be lost or doubled.

## Release checklist

- `npm run prepublishOnly` green on Node 20 and 22
- `npm publish --dry-run` — confirm the tarball contains `dist/`, `plugin/`, docs
- Tag, publish, then submit/refresh the entry on awesome-codex-plugins
- Re-run `codex app-server generate-ts` against the newest codex and diff — the
  app-server surface is experimental and drifts; adapters live in `src/sinks/`.

## Style

Biome-formatted, strict TypeScript, ESM. Keep the AgentAdapter seam clean: nothing
outside `src/sinks/` may know how turns reach Codex. Sources own payload trimming;
nothing downstream of a source may see raw provider payloads.
