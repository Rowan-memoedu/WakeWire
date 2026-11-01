import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../client.js";
import type { Delivery } from "../db/repos.js";
import { GithubMaintenanceClient, type WorkflowRun } from "./github-maintenance.js";
import {
  MaintenanceConfigSchema,
  type MaintenanceReceipt,
  type NativeCheck,
} from "./maintenance-types.js";
import {
  nativeProgress,
  nativePrompt,
  repositoryFromOrigin,
  updateReceipt,
  validateNativeRun,
} from "./native-maintenance.js";

afterEach(() => vi.restoreAllMocks());

describe("renamed repository submission", () => {
  it("uses GitHub's canonical repository name for profiles and PR identity", async () => {
    const request = vi
      .spyOn(GithubMaintenanceClient.prototype, "request")
      .mockResolvedValue({ full_name: "owner/current-name", private: true, archived: false });
    await expect(
      repositoryFromOrigin("https://github.com/owner/old-name.git", "owner/hub"),
    ).resolves.toBe("owner/current-name");
    expect(request).toHaveBeenCalledWith("repos/owner/old-name");
  });

  it("does not follow a redirected repository into a different account", async () => {
    vi.spyOn(GithubMaintenanceClient.prototype, "request").mockResolvedValue({
      full_name: "another/current-name",
      private: true,
      archived: false,
    });
    await expect(
      repositoryFromOrigin("git@github.com:owner/old-name.git", "owner/hub"),
    ).rejects.toThrow("active private maintenance source");
  });
});

describe("concurrent maintenance receipts", () => {
  it("preserves an accepted run when reconciliation only updated progress", async () => {
    const original = {
      id: "delivery",
      maintenance: { revision: 1, nativeChecks: [] },
    } as unknown as Delivery;
    const latest = {
      ...original,
      maintenance: { ...original.maintenance, revision: 2, lastStatus: "running" },
    } as Delivery;
    const patch = { nativeChecks: [{ id: "check", runId: 42 }] } as Partial<MaintenanceReceipt>;
    const updated = {
      ...latest,
      maintenance: { ...latest.maintenance, ...patch, revision: 3 },
    } as Delivery;
    const api = vi
      .spyOn(client, "apiFetch")
      .mockResolvedValueOnce({ status: 409, body: { error: "stale maintenance receipt" } })
      .mockResolvedValueOnce({ status: 200, body: { delivery: latest } })
      .mockResolvedValueOnce({ status: 200, body: { delivery: updated } });
    expect(await updateReceipt(original, patch)).toEqual(updated);
    expect(api.mock.calls[2]?.[1]?.body).toEqual({ revision: 2, ...patch });
  });

  it("does not overwrite a concurrently changed submission set", async () => {
    const original = {
      id: "delivery",
      maintenance: { revision: 1, nativeChecks: [] },
    } as unknown as Delivery;
    const api = vi
      .spyOn(client, "apiFetch")
      .mockResolvedValueOnce({ status: 409, body: { error: "stale maintenance receipt" } })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          delivery: {
            ...original,
            maintenance: { revision: 2, nativeChecks: [{ id: "another" }] },
          },
        },
      });
    await expect(updateReceipt(original, { nativeChecks: [] })).rejects.toThrow("field changed");
    expect(api).toHaveBeenCalledTimes(2);
  });
});

describe("ordinary native Threads with multi-repository PR completion", () => {
  const hub = "owner/hub";
  const requestId = "rn-native-test";
  const checks: NativeCheck[] = ["project", "dependency"].map((name, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    repository: `owner/${name}`,
    branch: `codex/maintenance-${requestId}`,
    head: String(index + 1).repeat(40),
    runId: index + 1,
    runUrl: `https://github.com/${hub}/actions/runs/${index + 1}`,
  }));
  const run = (check: NativeCheck): WorkflowRun => ({
    id: check.runId as number,
    html_url: check.runUrl as string,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    path: ".github/workflows/native-maintenance.yml",
    head_branch: "main",
    event: "workflow_dispatch",
    display_title: `${check.repository} · ${requestId} · ${check.head}`,
    actor: { login: "owner" },
  });

  it("preserves the request verbatim and adds delivery instructions without overriding native configuration", () => {
    const original = "原始命令 $(不要执行这个片段)\n  - 保留 $x^2$ 和原文";
    const prompt = nativePrompt(
      original,
      "owner/project",
      "D:/Projects/project",
      requestId,
      "D:/AppData/job.json",
      "D:/Applications/submit.js",
    );
    expect(prompt).toContain(original);
    expect(prompt).toContain("关联项目");
    expect(prompt).not.toMatch(/offline|ignore-user-config|ephemeral|allowlist|只访问当前仓库/);
  });

  it("does not accept a legacy workflow or a different candidate commit as native verification", () => {
    const check = checks[0] as NativeCheck;
    expect(() => validateNativeRun(run(check), check, hub, requestId)).not.toThrow();
    expect(() =>
      validateNativeRun(
        { ...run(check), path: ".github/workflows/maintenance.yml" },
        check,
        hub,
        requestId,
      ),
    ).toThrow();
    expect(() =>
      validateNativeRun(
        { ...run(check), display_title: `${check.repository} · ${requestId} · ${"a".repeat(40)}` },
        check,
        hub,
        requestId,
      ),
    ).toThrow();
  });

  it("waits for the explicit complete PR set and every exact related head to merge", async () => {
    const config = MaintenanceConfigSchema.parse({
      hub,
      mcpUrl: "http://localhost/mcp",
      wakewireHome: "D:/AppData/fixture",
      legacyDocumentRemId: "root",
      legacyRouteId: "ordinary",
      resultRoot: "D:/Artifacts/fixture",
      bindings: [{ documentRemId: "doc", title: "project", repository: "owner/project" }],
    });
    const receipt: MaintenanceReceipt = {
      revision: 0,
      documentRemId: "doc",
      taskRemId: "task",
      originalTitle: "%fix",
      requestId,
      fingerprint: "a".repeat(64),
      started: true,
      completed: false,
      nativeRequested: true,
      nativeThreadId: "native",
      nativeTurnId: "turn",
      nativeChecks: checks,
      nativeFinalized: false,
    };
    const merged = new Set(["owner/project"]);
    let wrongHead = false;
    vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      const check = checks.find((c) => String(file).includes(`${c.runId}-1`)) as NativeCheck;
      return JSON.stringify({
        mode: "native",
        status: "success",
        repository: check.repository,
        branch: check.branch,
        run: check.runUrl,
        pullRequest: `https://github.com/${check.repository}/pull/1`,
        head: check.head,
        submittedHead: check.head,
      });
    });
    vi.spyOn(GithubMaintenanceClient.prototype, "request").mockImplementation(
      async <T>(endpoint: string): Promise<T> => {
        const check = checks.find((c) => endpoint.endsWith(`/actions/runs/${c.runId}`));
        if (check) return run(check) as T;
        const pr = checks.find((c) => endpoint === `repos/${c.repository}/pulls/1`);
        if (pr)
          return {
            merged: merged.has(pr.repository),
            state: merged.has(pr.repository) ? "closed" : "open",
            html_url: `https://github.com/${pr.repository}/pull/1`,
            head: {
              sha: wrongHead ? "f".repeat(40) : pr.head,
              ref: pr.branch,
              repo: { full_name: pr.repository },
            },
            base: { ref: "main", repo: { full_name: pr.repository } },
          } as T;
        return { default_branch: "main" } as T;
      },
    );
    const delivery = { maintenance: receipt } as Delivery;
    expect((await nativeProgress(config, delivery)).complete).toBe(false);
    receipt.nativeFinalized = true;
    expect((await nativeProgress(config, delivery)).complete).toBe(false);
    merged.add("owner/dependency");
    expect((await nativeProgress(config, delivery)).complete).toBe(true);
    wrongHead = true;
    expect((await nativeProgress(config, delivery)).complete).toBe(false);
  });
});
