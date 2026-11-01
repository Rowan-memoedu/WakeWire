import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Delivery } from "../db/repos.js";
import { GithubMaintenanceClient } from "./github-maintenance.js";
import {
  latestNativeChecks,
  MaintenanceConfigSchema,
  type NativeCheck,
} from "./maintenance-types.js";
import { maintenanceApi, nativeCheckStatus, updateReceipt } from "./native-maintenance.js";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const [command, requestFile, repoPath, summary, retryFlag] = process.argv.slice(2);
  if (
    !requestFile ||
    !path.isAbsolute(requestFile) ||
    !["submit", "finalize", "status"].includes(command ?? "")
  )
    throw new Error(
      "usage: native-maintenance-cli submit <request.json> <repository path> <summary> [--retry] | finalize|status <request.json>",
    );
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as {
    configFile: string;
    deliveryId: string;
  };
  if (!path.isAbsolute(request.configFile) || !/^[a-f0-9-]{36}$/.test(request.deliveryId))
    throw new Error("invalid native maintenance request");
  const config = MaintenanceConfigSchema.parse(
    JSON.parse(fs.readFileSync(request.configFile, "utf8")),
  );
  process.env.WAKEWIRE_HOME = config.wakewireHome;
  const load = async () =>
    (
      await maintenanceApi<{ delivery: Delivery }>(
        `/api/deliveries/${request.deliveryId}/maintenance`,
      )
    ).delivery;
  let delivery = await load();
  let receipt = delivery.maintenance;
  if (!receipt?.nativeRequested || receipt.completed)
    throw new Error("native request is not active");
  const github = new GithubMaintenanceClient(config.hub);
  if (command === "submit") {
    if (
      !repoPath ||
      !path.isAbsolute(repoPath) ||
      !summary?.trim() ||
      summary.length > 8000 ||
      (retryFlag && retryFlag !== "--retry")
    )
      throw new Error(
        "submit requires a local repository, a concise change summary and optional --retry",
      );
    const remote = await git(repoPath, "remote", "get-url", "origin");
    const matched =
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote);
    const repository = matched?.[1];
    if (
      !repository ||
      repository.split("/")[0]?.toLowerCase() !== config.hub.split("/")[0]?.toLowerCase()
    )
      throw new Error("repository origin does not belong to this maintenance account");
    const branch = `codex/maintenance-${receipt.requestId}`;
    // The candidate ref may be prepared without switching the user's active checkout.
    const head = await git(repoPath, "rev-parse", `refs/heads/${branch}`);
    const ref = await github.request<{ object: { sha: string } }>(
      `repos/${repository}/git/ref/heads/${branch}`,
    );
    if (ref.object.sha !== head)
      throw new Error("the local candidate has not been pushed to its request branch");
    let check = latestNativeChecks(receipt.nativeChecks ?? []).find(
      (c) => c.repository.toLowerCase() === repository.toLowerCase(),
    );
    if (check && !check.runId)
      throw new Error("an earlier dispatch has an unknown outcome; inspect it before retrying");
    if (check?.head !== head || retryFlag === "--retry") {
      check = { id: crypto.randomUUID(), repository, branch, head };
      delivery = await updateReceipt(delivery, {
        nativeChecks: [...(receipt.nativeChecks ?? []), check],
        nativeFinalized: false,
      });
      receipt = delivery.maintenance as NonNullable<Delivery["maintenance"]>;
      const response = await github.request<{ workflow_run_id: number; html_url: string }>(
        `repos/${config.hub}/actions/workflows/native-maintenance.yml/dispatches`,
        {
          ref: "main",
          return_run_details: true,
          inputs: { project: repository, request_id: receipt.requestId, head_sha: head, summary },
        },
      );
      if (
        !Number.isSafeInteger(response.workflow_run_id) ||
        response.workflow_run_id <= 0 ||
        response.html_url !==
          `https://github.com/${config.hub}/actions/runs/${response.workflow_run_id}`
      )
        throw new Error("verification acceptance identity is unknown; no automatic replay");
      check = { ...check, runId: response.workflow_run_id, runUrl: response.html_url };
      delivery = await updateReceipt(delivery, {
        nativeChecks: (receipt.nativeChecks ?? []).map((c) =>
          c.id === check?.id ? check : c,
        ) as NativeCheck[],
      });
      receipt = delivery.maintenance as NonNullable<Delivery["maintenance"]>;
    }
    if (!check) throw new Error("verification submission missing");
    console.log(JSON.stringify({ repository, head, runUrl: check.runUrl }));
    const deadline = Date.now() + 2 * 60 * 60_000;
    while (Date.now() < deadline) {
      const result = await nativeCheckStatus(config, receipt, check, github);
      console.log(
        JSON.stringify({
          repository,
          status: result.status,
          runUrl: check.runUrl,
          prUrl: result.prUrl,
        }),
      );
      if (["success", "merged"].includes(result.status)) return;
      if (result.run.status === "completed")
        throw new Error(
          `Actions needs repair; local diagnostics: ${path.join(config.resultRoot, `${result.run.id}-${result.run.run_attempt}`)}. Continue in this same Thread, then submit the corrected commit.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    throw new Error(
      "verification is still queued/running; its identity is retained. Reuse submit to keep observing it",
    );
  }
  const checks = latestNativeChecks(receipt.nativeChecks ?? []);
  if (!checks.length) throw new Error("no related PR submissions have been recorded");
  for (const check of checks) {
    const result = await nativeCheckStatus(config, receipt, check, github);
    console.log(
      JSON.stringify({ repository: check.repository, status: result.status, prUrl: result.prUrl }),
    );
    if (command === "finalize" && !["success", "merged"].includes(result.status))
      throw new Error("all related repository checks must pass before finalizing the PR set");
  }
  if (command === "finalize") {
    delivery = await load();
    // Refuse to seal a changed set after asynchronous checks.
    if (JSON.stringify(delivery.maintenance?.nativeChecks) !== JSON.stringify(receipt.nativeChecks))
      throw new Error("submissions changed during finalization; inspect the latest set");
    await updateReceipt(delivery, { nativeFinalized: true });
    console.log(
      "All related PRs are recorded. RemNote will complete after every verified PR is merged.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "native maintenance failed");
    process.exitCode = 1;
  });
