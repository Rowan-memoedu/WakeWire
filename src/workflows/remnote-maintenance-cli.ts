import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { apiFetch } from "../client.js";
import type { Route } from "../core/route.js";
import type { Delivery } from "../db/repos.js";
import { VERSION } from "../version.js";
import {
  GithubMaintenanceClient,
  type MaintenanceResult,
  type PullRequest,
  validateResult,
  verifiedMerged,
  type WorkflowRun,
} from "./github-maintenance.js";
import {
  type MaintenanceBinding,
  type MaintenanceConfig,
  MaintenanceConfigSchema,
  type MaintenanceReceipt,
} from "./maintenance-types.js";
import {
  ensureNativeDelivery,
  nativeProgress,
  updateReceipt as patchReceipt,
  verifyNativeRoute,
} from "./native-maintenance.js";
import { NativeProjectRegistry } from "./native-project.js";
import {
  ensureBuckets,
  placeCompleted,
  placeStarted,
  taskFingerprint,
  verifyDocument,
  writeFeedback,
} from "./remnote-maintenance.js";
import { eventIdFor, scanTodo } from "./remnote-todo.js";
import { RemNoteMcp } from "./remnote-todo-cli.js";

async function api<T>(endpoint: string, body?: unknown, method = "POST"): Promise<T> {
  const result = await apiFetch<T & { error?: string }>(
    endpoint,
    body === undefined ? {} : { method, body },
  );
  if (result.status < 200 || result.status >= 300)
    throw new Error(result.body?.error ?? `WakeWire returned HTTP ${result.status}`);
  return result.body;
}

function expectedTarget(config: MaintenanceConfig, b: MaintenanceBinding) {
  return {
    type: "github-actions",
    repository: b.repository,
    hub: config.hub,
    workflow: "maintenance.yml",
    ref: "main",
    documentRemId: b.documentRemId,
  } as const;
}

async function verifyRoutes(config: MaintenanceConfig): Promise<void> {
  const health = await api<{ version: string }>("/api/health");
  if (health.version !== VERSION)
    throw new Error("installed maintenance client and daemon versions differ");
  const routes = (await api<{ routes: Route[] }>("/api/routes")).routes;
  for (const binding of config.bindings) {
    const route = routes.find((r) => r.id === binding.routeId);
    if (
      !route?.enabled ||
      JSON.stringify(route.target) !== JSON.stringify(expectedTarget(config, binding))
    )
      throw new Error(`mapping is disabled or changed: ${binding.title}`);
  }
}

async function verifyRepositories(
  config: MaintenanceConfig,
  github: GithubMaintenanceClient,
  requireOwner: boolean,
): Promise<Map<string, string>> {
  const owner = config.hub.split("/")[0] as string;
  if (requireOwner) {
    const user = await github.request<{ login: string }>("user");
    if (user.login.toLowerCase() !== owner.toLowerCase())
      throw new Error("only the repository owner may dispatch maintenance");
  }
  const bases = new Map<string, string>();
  for (const repository of new Set([config.hub, ...config.bindings.map((b) => b.repository)])) {
    const repo = await github.request<{
      private: boolean;
      archived: boolean;
      full_name: string;
      default_branch: string;
    }>(`repos/${repository}`);
    if (!repo.private || repo.archived || repo.full_name.toLowerCase() !== repository.toLowerCase())
      throw new Error(`repository is not an active private source: ${repository}`);
    bases.set(repository, repo.default_branch);
  }
  return bases;
}

async function setup(config: MaintenanceConfig, configFile: string): Promise<void> {
  await verifyRepositories(config, new GithubMaintenanceClient(), true);
  const routes = (await api<{ routes: Route[] }>("/api/routes")).routes;
  for (const binding of config.bindings) {
    const target = expectedTarget(config, binding);
    const existing = routes.filter(
      (r) => r.target.type === "github-actions" && r.target.documentRemId === binding.documentRemId,
    );
    if (existing.length > 1) throw new Error("duplicate document routes");
    if (existing[0]) {
      if (JSON.stringify(existing[0].target) !== JSON.stringify(target) || !existing[0].enabled)
        throw new Error("existing mapping differs or is paused; no overwrite");
      binding.routeId = existing[0].id;
    } else {
      const { route } = await api<{ route: Route }>("/api/routes", {
        name: `RemNote → ${binding.repository}`,
        source: "webhook",
        match: { provider: "remnote-maintenance" },
        target,
        sandbox: "read-only",
        enabled: true,
      });
      binding.routeId = route.id;
    }
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  await verifyRoutes(config);
  if (config.execution === "native") {
    await verifyNativeRoute(config);
    const native = config.native as NonNullable<MaintenanceConfig["native"]>;
    const registry = new NativeProjectRegistry(undefined, native.appOwnerThreadId);
    try {
      await registry.verifyProject(native.appProjectId, native.cwd);
    } finally {
      await registry.close();
    }
  }
  const remnote = new RemNoteMcp();
  try {
    await remnote.connect(config.mcpUrl);
    for (const b of config.bindings) {
      await verifyDocument(remnote, b.documentRemId, config.legacyDocumentRemId);
      await ensureBuckets(remnote, b.documentRemId);
    }
  } finally {
    await remnote.close();
  }
  console.log(JSON.stringify({ configured: config.bindings.length, dispatched: 0 }));
}

async function processBindings(
  config: MaintenanceConfig,
  configFile: string,
  mode: "run" | "reconcile" | "scan" | "check",
): Promise<void> {
  await verifyRoutes(config);
  if (config.execution === "native") await verifyNativeRoute(config);
  const github = new GithubMaintenanceClient(config.hub);
  const bases = await verifyRepositories(config, github, mode === "run");
  const remnote = new RemNoteMcp();
  const report = {
    mode,
    startedAt: new Date().toISOString(),
    dispatched: [] as Array<{ repository: string; taskRemId: string; runUrl: string }>,
    completed: [] as string[],
    errors: [] as Array<{ taskRemId?: string; message: string }>,
    scanned: [] as Array<{ title: string; marked: number; conflicts: number }>,
  };
  try {
    await remnote.connect(config.mcpUrl);
    for (const binding of config.bindings) {
      try {
        await verifyDocument(remnote, binding.documentRemId, config.legacyDocumentRemId);
        if (mode === "check") continue;
        const buckets =
          mode === "scan" ? null : await ensureBuckets(remnote, binding.documentRemId);
        if (mode === "run" || mode === "scan") {
          const excluded = new Set(
            config.bindings
              .filter((b) => b.documentRemId !== binding.documentRemId)
              .map((b) => b.documentRemId),
          );
          if (buckets) excluded.add(buckets.completed);
          const scan = await scanTodo(remnote, binding.documentRemId, () => {}, excluded);
          report.scanned.push({
            title: binding.title,
            marked: scan.tasks.length,
            conflicts: scan.conflicts.length,
          });
          for (const taskRemId of scan.conflicts)
            report.errors.push({ taskRemId, message: "overlapping % markers; no dispatch" });
          if (mode === "run")
            for (const task of scan.tasks) {
              try {
                const oldQuery = new URLSearchParams({
                  routeId: config.legacyRouteId,
                  sourceDeliveryId: eventIdFor(config.legacyDocumentRemId, task.taskRemId),
                  limit: "1",
                });
                const legacy = await api<{ deliveries: Delivery[] }>(`/api/deliveries?${oldQuery}`);
                if (legacy.deliveries.length)
                  throw new Error(
                    "task already has an ordinary To Do receipt; no duplicate Actions dispatch",
                  );
                const fingerprint = await taskFingerprint(remnote, task.taskRemId);
                if (fingerprint !== task.subtreeFingerprint)
                  throw new Error("task changed since command export; not dispatched");
                const claim = await api<{ created: boolean; delivery: Delivery }>(
                  `/api/routes/${binding.routeId}/maintenance`,
                  {
                    taskRemId: task.taskRemId,
                    originalTitle: task.title,
                    prompt: task.prompt,
                    fingerprint,
                    ...(config.execution === "native" ? { nativeRequested: true } : {}),
                  },
                );
                if (!claim.created) continue;
                let delivery = claim.delivery;
                if (config.execution === "native") {
                  await ensureNativeDelivery(config, configFile, binding, delivery);
                  continue;
                }
                try {
                  const response = await github.request<{
                    workflow_run_id: number;
                    html_url: string;
                  }>(`repos/${config.hub}/actions/workflows/maintenance.yml/dispatches`, {
                    ref: "main",
                    return_run_details: true,
                    inputs: {
                      project: binding.repository,
                      task: task.prompt,
                      request_id: delivery.maintenance?.requestId,
                    },
                  });
                  if (
                    !Number.isSafeInteger(response.workflow_run_id) ||
                    response.workflow_run_id <= 0 ||
                    response.html_url !==
                      `https://github.com/${config.hub}/actions/runs/${response.workflow_run_id}`
                  )
                    throw new Error("invalid Actions acceptance identity; no replay");
                  delivery = await patchReceipt(delivery, { runId: response.workflow_run_id });
                  report.dispatched.push({
                    repository: binding.repository,
                    taskRemId: task.taskRemId,
                    runUrl: response.html_url,
                  });
                } catch (error) {
                  // A lost HTTP response is not evidence that GitHub did nothing.
                  await patchReceipt(delivery, {
                    lastStatus: "投放结果待核对；已停止自动重发",
                  }).catch(() => {});
                  throw error;
                }
              } catch (error) {
                report.errors.push({
                  taskRemId: task.taskRemId,
                  message: error instanceof Error ? error.message : "dispatch failed",
                });
              }
            }
        }
        if (!buckets) continue;
        const deliveries = (
          await api<{ deliveries: Delivery[] }>(`/api/routes/${binding.routeId}/maintenance`)
        ).deliveries;
        for (let delivery of deliveries) {
          let receipt = delivery.maintenance;
          if (!receipt || receipt.completed) continue;
          try {
            if (receipt.nativeRequested) {
              delivery = await ensureNativeDelivery(config, configFile, binding, delivery);
              // Native creation is asynchronous. Briefly await the normal intake's acceptance.
              for (
                let attempt = 0;
                !delivery.maintenance?.nativeTurnId && attempt < 15;
                attempt++
              ) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                delivery = await ensureNativeDelivery(config, configFile, binding, delivery);
              }
              receipt = delivery.maintenance as MaintenanceReceipt;
              if (!receipt.started && receipt.nativeTurnId) {
                await placeStarted(remnote, receipt, buckets.started);
                delivery = await patchReceipt(delivery, { started: true });
                receipt = delivery.maintenance as MaintenanceReceipt;
              }
              const progress = await nativeProgress(config, delivery);
              const feedbackRemId = await writeFeedback(
                remnote,
                receipt,
                progress.status,
                undefined,
                progress.links,
              );
              delivery = await patchReceipt(delivery, {
                feedbackRemId,
                lastStatus: progress.status,
              });
              receipt = delivery.maintenance as MaintenanceReceipt;
              if (progress.complete) {
                await placeCompleted(remnote, receipt, buckets.started, buckets.completed);
                await patchReceipt(delivery, { completed: true });
                report.completed.push(receipt.taskRemId);
              }
              continue;
            }
            if (!receipt.runId || !receipt.runUrl)
              throw new Error("dispatch outcome unknown; retained without replay");
            if (!receipt.started) {
              await placeStarted(remnote, receipt, buckets.started);
              delivery = await patchReceipt(delivery, { started: true });
              receipt = delivery.maintenance as MaintenanceReceipt;
            }
            const run = await github.request<WorkflowRun>(
              `repos/${config.hub}/actions/runs/${receipt.runId}`,
            );
            if (
              run.id !== receipt.runId ||
              run.html_url !== receipt.runUrl ||
              run.event !== "workflow_dispatch" ||
              run.head_branch !== "main" ||
              run.path !== ".github/workflows/maintenance.yml" ||
              !run.display_title.endsWith(` · ${receipt.requestId}`) ||
              run.actor.login.toLowerCase() !== config.hub.split("/")[0]?.toLowerCase()
            )
              throw new Error("Actions run identity does not match receipt");
            let status = run.status === "queued" ? "已投放，等待运行" : "运行中";
            let prUrl: string | undefined;
            let complete = false;
            if (run.status === "completed") {
              if (run.conclusion !== "success")
                status = `工作流未成功（${run.conclusion ?? "unknown"}），保留待处理`;
              else {
                if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
                  throw new Error("invalid workflow attempt");
                const resultPath = path.join(
                  config.resultRoot,
                  `${run.id}-${run.run_attempt}`,
                  "reports",
                  "result.json",
                );
                if (!fs.existsSync(resultPath))
                  throw new Error(
                    "workflow succeeded, but the matching result report is unavailable",
                  );
                const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as MaintenanceResult;
                const number = validateResult(
                  result,
                  binding.repository,
                  receipt.requestId,
                  receipt.runUrl as string,
                );
                if (number === null) status = "工作流成功，无需修改；没有 PR，保留已开始";
                else {
                  prUrl = result.pullRequest as string;
                  const pr = await github.request<PullRequest>(
                    `repos/${binding.repository}/pulls/${number}`,
                  );
                  complete = verifiedMerged(
                    run,
                    result,
                    pr,
                    binding.repository,
                    receipt.requestId,
                    receipt.runUrl as string,
                    bases.get(binding.repository) as string,
                  );
                  status = complete
                    ? "PR 已合并"
                    : pr.merged
                      ? "PR 已合并，但合并内容与已验证结果不一致，需核对"
                      : pr.state === "closed"
                        ? "PR 已关闭但未合并，保留待处理"
                        : "工作流成功，等待审核合并 PR";
                }
              }
            }
            const feedbackRemId = await writeFeedback(remnote, receipt, status, prUrl);
            delivery = await patchReceipt(delivery, {
              feedbackRemId,
              lastStatus: status,
              ...(prUrl ? { prUrl } : {}),
            });
            receipt = delivery.maintenance as MaintenanceReceipt;
            if (complete) {
              await placeCompleted(remnote, receipt, buckets.started, buckets.completed);
              await patchReceipt(delivery, { completed: true });
              report.completed.push(receipt.taskRemId);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "reconciliation failed";
            report.errors.push({ taskRemId: receipt.taskRemId, message });
          }
        }
      } catch (error) {
        report.errors.push({
          message: `${binding.title}: ${error instanceof Error ? error.message : "workflow failed"}`,
        });
      }
    }
  } finally {
    await remnote.close();
    const reportFile = path.join(path.dirname(configFile), `last-${mode}.json`);
    fs.writeFileSync(
      reportFile,
      `${JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ ...report, reportFile }));
  }
  if (report.errors.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [mode, configFile, ...taskRemIds] = process.argv.slice(2);
  if (
    !configFile ||
    !path.isAbsolute(configFile) ||
    !["setup", "run", "reconcile", "scan", "check", "targets", "retry-native"].includes(mode ?? "")
  )
    throw new Error(
      "usage: remnote-maintenance-cli setup|run|reconcile|scan|check|targets <absolute-config.json>",
    );
  const config = MaintenanceConfigSchema.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
  if (!path.isAbsolute(config.wakewireHome) || !path.isAbsolute(config.resultRoot))
    throw new Error("maintenance data paths must be absolute");
  process.env.WAKEWIRE_HOME = config.wakewireHome;
  if (mode === "targets") {
    const related: string[] = [];
    for (const binding of config.bindings) {
      if (!binding.routeId) continue;
      const { deliveries } = await api<{ deliveries: Delivery[] }>(
        `/api/routes/${binding.routeId}/maintenance`,
      );
      for (const delivery of deliveries)
        for (const check of delivery.maintenance?.nativeChecks ?? [])
          related.push(check.repository);
    }
    console.log(
      [...new Set([config.hub, ...config.bindings.map((b) => b.repository), ...related])]
        .map((r) => r.split("/")[1])
        .join(","),
    );
    return;
  }
  // A bounded command lock only coordinates RemNote writes. Actions remains the job scheduler.
  const lockFile = path.join(path.dirname(configFile), "operation.lock");
  const nonce = crypto.randomUUID();
  if (fs.existsSync(lockFile)) {
    const old = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number };
    try {
      process.kill(old.pid, 0);
      throw new Error("another maintenance synchronization is active");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      fs.unlinkSync(lockFile);
    }
  }
  const fd = fs.openSync(lockFile, "wx", 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
  fs.closeSync(fd);
  try {
    if (mode === "setup") await setup(config, configFile);
    else if (mode === "retry-native") {
      if (config.execution !== "native" || !taskRemIds.length)
        throw new Error("retry-native requires explicit source task IDs and native configuration");
      await verifyRoutes(config);
      await verifyNativeRoute(config);
      const github = new GithubMaintenanceClient(config.hub);
      await verifyRepositories(config, github, true);
      const remnote = new RemNoteMcp();
      const remaining = new Set(taskRemIds);
      try {
        await remnote.connect(config.mcpUrl);
        for (const binding of config.bindings) {
          const { deliveries } = await api<{ deliveries: Delivery[] }>(
            `/api/routes/${binding.routeId}/maintenance`,
          );
          for (let delivery of deliveries) {
            const receipt = delivery.maintenance;
            if (!receipt || !remaining.has(receipt.taskRemId)) continue;
            if (receipt.completed) throw new Error("completed work cannot be retried");
            if (!receipt.nativeRequested) {
              if (!receipt.runId) throw new Error("unknown legacy dispatch cannot be retried");
              const run = await github.request<WorkflowRun>(
                `repos/${config.hub}/actions/runs/${receipt.runId}`,
              );
              if (run.status !== "completed" || run.conclusion !== "failure")
                throw new Error(
                  "only explicitly failed legacy runs may migrate to native execution",
                );
              const report = JSON.parse(
                fs.readFileSync(
                  path.join(
                    config.resultRoot,
                    `${run.id}-${run.run_attempt}`,
                    "reports",
                    "result.json",
                  ),
                  "utf8",
                ),
              ) as MaintenanceResult;
              if (
                report.run !== receipt.runUrl ||
                report.repository !== binding.repository ||
                report.pullRequest
              )
                throw new Error("legacy result may have published work; review before retrying");
              if (
                (await taskFingerprint(remnote, receipt.taskRemId, receipt.feedbackRemId)) !==
                receipt.fingerprint
              )
                throw new Error("source changed; do not retry a stale request");
              delivery = await patchReceipt(delivery, {
                nativeRequested: true,
                nativeFinalized: false,
                nativeChecks: [],
              });
            }
            await ensureNativeDelivery(config, configFile, binding, delivery);
            remaining.delete(receipt.taskRemId);
          }
        }
      } finally {
        await remnote.close();
      }
      if (remaining.size)
        throw new Error("some requested source tasks have no maintenance receipt");
      await processBindings(config, configFile, "reconcile");
    } else
      await processBindings(config, configFile, mode as "run" | "reconcile" | "scan" | "check");
  } finally {
    const current = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { nonce: string };
    if (current.nonce === nonce) fs.unlinkSync(lockFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "maintenance workflow failed");
    process.exitCode = 1;
  });
