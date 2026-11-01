import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiFetch } from "../client.js";
import type { Route } from "../core/route.js";
import type { Delivery } from "../db/repos.js";
import {
  GithubMaintenanceClient,
  type MaintenanceResult,
  type PullRequest,
  verifiedMerged,
  type WorkflowRun,
} from "./github-maintenance.js";
import {
  latestNativeChecks,
  type MaintenanceBinding,
  type MaintenanceConfig,
  type MaintenanceReceipt,
  type NativeCheck,
} from "./maintenance-types.js";
import { NativeProjectRegistry } from "./native-project.js";

export async function maintenanceApi<T>(
  endpoint: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const result = await apiFetch<T & { error?: string }>(
    endpoint,
    body === undefined ? {} : { method, body },
  );
  if (result.status < 200 || result.status >= 300)
    throw new Error(result.body?.error ?? `WakeWire returned HTTP ${result.status}`);
  return result.body;
}

export async function updateReceipt(
  delivery: Delivery,
  patch: Partial<MaintenanceReceipt>,
): Promise<Delivery> {
  const endpoint = `/api/deliveries/${delivery.id}/maintenance`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return (
        await maintenanceApi<{ delivery: Delivery }>(
          endpoint,
          { revision: delivery.maintenance?.revision, ...patch },
          "PATCH",
        )
      ).delivery;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "stale maintenance receipt") throw error;
      const latest = (await maintenanceApi<{ delivery: Delivery }>(endpoint)).delivery;
      // A status refresh must not lose an already accepted dispatch. Only retry
      // if none of this update's fields were changed by the other writer.
      for (const key of Object.keys(patch) as (keyof MaintenanceReceipt)[]) {
        const current = JSON.stringify(latest.maintenance?.[key]);
        if (
          current !== JSON.stringify(delivery.maintenance?.[key]) &&
          current !== JSON.stringify(patch[key])
        )
          throw new Error(`maintenance receipt field changed: ${key}`);
      }
      delivery = latest;
    }
  }
  throw new Error("maintenance receipt is still changing; no dispatch was replayed");
}

export async function verifyNativeRoute(config: MaintenanceConfig): Promise<void> {
  const native = config.native;
  if (!native) throw new Error("native project configuration missing");
  const routes = (await maintenanceApi<{ routes: Route[] }>("/api/routes")).routes;
  const route = routes.find((r) => r.id === (native.routeId ?? config.legacyRouteId));
  if (
    !route?.enabled ||
    route.target.type !== "new-thread" ||
    route.target.worktree ||
    route.target.promptMode !== "verbatim" ||
    route.sandbox !== "user-config" ||
    route.promptTemplate ||
    route.target.appProjectId !== native.appProjectId ||
    route.target.appOwnerThreadId !== native.appOwnerThreadId ||
    route.target.cwd !== native.cwd
  )
    throw new Error("ordinary native Thread route changed or is unavailable");
}

export function nativePrompt(
  original: string,
  repository: string,
  localPath: string,
  requestId: string,
  requestFile: string,
  entry: string,
): string {
  return `维护 ${repository}，本地源码在 ${localPath}。用户已明确要求按普通本地 Codex Thread 使用 Full access 全部权限，不添加额外执行约束；沿用已有协作约定，需要处理关联项目时一并完成。\n\n${original}\n\n本次交付接入已有 GitHub Actions 与 RemNote 进度：\n将本次各仓库的变更提交并推送到各自的 codex/maintenance-${requestId} 分支。对每个改动仓库运行：\nnode "${entry}" submit "${requestFile}" "该仓库的本地绝对路径" "简洁说明具体修复及行为变化"\n该命令运行 Actions 独立检查，通过后创建或复用 PR，并返回检查结果。依据检查反馈继续修复；需要重新检查相同提交时可在命令末尾加 --retry。全部相关仓库的提交和检查完成后运行：\nnode "${entry}" finalize "${requestFile}"\n同一请求的所有相关 PR 合并后，原 RemNote 任务会自动归档。`;
}

/** The ordinary authenticated prompt intake owns native create_thread and its no-replay receipts. */
export async function ensureNativeDelivery(
  config: MaintenanceConfig,
  configFile: string,
  binding: MaintenanceBinding,
  delivery: Delivery,
): Promise<Delivery> {
  const receipt = delivery.maintenance;
  if (!receipt?.nativeRequested || !config.native || !binding.localPath)
    throw new Error("native request is not configured");
  await verifyNativeRoute(config);
  const routeId = config.native.routeId ?? config.legacyRouteId;
  const sourceDeliveryId = `native-maintenance:${receipt.requestId}`;
  const query = new URLSearchParams({ routeId, sourceDeliveryId, limit: "1" });
  const find = async () =>
    (await maintenanceApi<{ deliveries: Delivery[] }>(`/api/deliveries?${query}`)).deliveries[0];
  let native = await find();
  if (!native) {
    const directory = path.join(path.dirname(configFile), "native-requests");
    fs.mkdirSync(directory, { recursive: true });
    const requestFile = path.join(directory, `${delivery.id}.json`);
    const request = { configFile, deliveryId: delivery.id };
    if (fs.existsSync(requestFile)) {
      const saved = JSON.parse(fs.readFileSync(requestFile, "utf8"));
      if (saved.configFile !== configFile || saved.deliveryId !== delivery.id)
        throw new Error("native request identity differs");
    } else
      fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    const entry = fileURLToPath(new URL("./native-maintenance-cli.js", import.meta.url));
    await maintenanceApi(`/api/routes/${routeId}/prompts`, {
      sourceDeliveryId,
      prompt: nativePrompt(
        delivery.renderedPrompt ?? "",
        binding.repository,
        binding.localPath,
        receipt.requestId,
        requestFile,
        entry,
      ),
    });
    native = await find();
  }
  if (!native) throw new Error("native intake receipt missing; no direct replay");
  const patch: Partial<MaintenanceReceipt> = {};
  if (!receipt.nativeDeliveryId) patch.nativeDeliveryId = native.id;
  if (native.threadId && !receipt.nativeThreadId) patch.nativeThreadId = native.threadId;
  if (native.turnId && !receipt.nativeTurnId) patch.nativeTurnId = native.turnId;
  if (native.threadId && !native.turnId && !receipt.nativeTurnId && native.status === "failed") {
    const registry = new NativeProjectRegistry(undefined, config.native.appOwnerThreadId);
    try {
      const snapshot = await registry.readThread(native.threadId);
      if (snapshot.latestTurn) patch.nativeTurnId = snapshot.latestTurn.id;
    } finally {
      await registry.close();
    }
  }
  if (Object.keys(patch).length) delivery = await updateReceipt(delivery, patch);
  return delivery;
}

export function validateNativeRun(
  run: WorkflowRun,
  check: NativeCheck,
  hub: string,
  requestId: string,
): void {
  if (
    run.id !== check.runId ||
    run.html_url !== `https://github.com/${hub}/actions/runs/${check.runId}` ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/native-maintenance.yml" ||
    !run.display_title.endsWith(` · ${requestId} · ${check.head}`) ||
    run.actor.login.toLowerCase() !== hub.split("/")[0]?.toLowerCase()
  )
    throw new Error("native verification run does not match the submitted commit");
}

export async function nativeCheckStatus(
  config: MaintenanceConfig,
  receipt: MaintenanceReceipt,
  check: NativeCheck,
  github = new GithubMaintenanceClient(config.hub),
) {
  if (!check.runId)
    throw new Error("verification dispatch outcome unknown; retained without replay");
  const run = await github.request<WorkflowRun>(`repos/${config.hub}/actions/runs/${check.runId}`);
  validateNativeRun(run, check, config.hub, receipt.requestId);
  if (run.status !== "completed")
    return { status: run.status, run, merged: false, prUrl: undefined as string | undefined };
  if (run.conclusion !== "success")
    return {
      status: `failure:${run.conclusion}`,
      run,
      merged: false,
      prUrl: undefined as string | undefined,
    };
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
    throw new Error("invalid verification attempt");
  const report = path.join(
    config.resultRoot,
    `${run.id}-${run.run_attempt}`,
    "reports",
    "result.json",
  );
  const result = JSON.parse(fs.readFileSync(report, "utf8")) as MaintenanceResult & {
    submittedHead?: string;
    mode?: string;
  };
  if (result.mode !== "native" || result.submittedHead !== check.head || result.head !== check.head)
    throw new Error("verification report did not test the submitted native commit");
  if (!result.pullRequest) throw new Error("native verification succeeded without a PR");
  const prNumber = result.pullRequest.split("/").at(-1);
  if (!prNumber || !/^[1-9]\d*$/.test(prNumber)) throw new Error("invalid native PR number");
  const [pr, repo] = await Promise.all([
    github.request<PullRequest>(`repos/${check.repository}/pulls/${prNumber}`),
    github.request<{ default_branch: string }>(`repos/${check.repository}`),
  ]);
  const merged = verifiedMerged(
    run,
    result,
    pr,
    check.repository,
    receipt.requestId,
    run.html_url,
    repo.default_branch,
  );
  const status = merged
    ? "merged"
    : pr.merged
      ? "mismatch"
      : pr.state === "closed"
        ? "closed"
        : "success";
  return { status, run, merged, prUrl: result.pullRequest };
}

export async function nativeProgress(config: MaintenanceConfig, delivery: Delivery) {
  const receipt = delivery.maintenance as MaintenanceReceipt;
  const links: string[] = [];
  const checks = latestNativeChecks(receipt.nativeChecks ?? []);
  let status = receipt.nativeTurnId ? "本地 Codex 正在处理" : "已进入现有本地 Codex 投放队列";
  let complete = receipt.nativeFinalized === true && checks.length > 0;
  let passed = 0;
  let failed = false;
  for (const check of checks) {
    if (check.runUrl) links.push(`${check.repository} Actions：${check.runUrl}`);
    const result = await nativeCheckStatus(config, receipt, check);
    if (result.prUrl) links.push(`${check.repository} PR：${result.prUrl}`);
    if (["success", "merged"].includes(result.status)) passed++;
    else failed = true;
    complete &&= result.merged;
  }
  if (complete) status = "所有关联 PR 已合并";
  else if (receipt.nativeFinalized && passed === checks.length && checks.length)
    status = `检查通过，等待 ${checks.length} 个关联 PR 合并`;
  else if (checks.length)
    status = failed
      ? "Actions 检查尚未全部通过，本地 Thread 可继续处理"
      : "关联 PR 已创建，等待本地 Thread 确认交付完整";
  else if (receipt.nativeDeliveryId) {
    const query = new URLSearchParams({
      routeId: config.native?.routeId ?? config.legacyRouteId,
      sourceDeliveryId: `native-maintenance:${receipt.requestId}`,
      limit: "1",
    });
    const result = (await maintenanceApi<{ deliveries: Delivery[] }>(`/api/deliveries?${query}`))
      .deliveries[0];
    if (result?.status === "delivered") status = "本地 Thread 本轮已结束，尚未完成 PR 交付";
    if (result?.status === "failed")
      status = receipt.nativeTurnId
        ? "本地 Thread 已接收，进度见原生 Thread"
        : "本地 Thread 需要关注，保留已有身份";
  }
  return { status, links, complete };
}
