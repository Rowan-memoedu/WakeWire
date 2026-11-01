import { spawn } from "node:child_process";

/** Official gh authentication; request text travels only on stdin, never through a shell. */
export class GithubMaintenanceClient {
  constructor(private readonly hub?: string) {}

  async request<T>(endpoint: string, payload?: unknown): Promise<T> {
    const args = [
      "api",
      endpoint,
      "--hostname",
      "github.com",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
    ];
    if (payload !== undefined) args.push("--method", "POST", "--input", "-");
    return new Promise((resolve, reject) => {
      const actionsToken =
        this.hub && endpoint.startsWith(`repos/${this.hub}/actions/`)
          ? process.env.GH_ACTIONS_TOKEN
          : undefined;
      const child = spawn("gh", args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: actionsToken ? { ...process.env, GH_TOKEN: actionsToken } : process.env,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let ended = false;
      const finish = (error?: Error, value?: T) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("GitHub request timed out; mutation outcome may be unknown"));
      }, 60_000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 10_000_000) {
          child.kill();
          finish(new Error("GitHub response exceeded safety limit"));
        } else chunks.push(chunk);
      });
      // Errors can echo task input. Do not copy raw CLI diagnostics into logs or RemNote.
      child.stderr.resume();
      child.on("error", () => finish(new Error("GitHub CLI could not start")));
      child.stdin.on("error", () => {});
      child.on("close", (code) => {
        if (code !== 0) return finish(new Error(`GitHub API request failed (exit ${code})`));
        try {
          finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch {
          finish(new Error("GitHub returned no valid JSON receipt"));
        }
      });
      child.stdin.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  }
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  html_url: string;
  path: string;
  head_branch: string;
  event: string;
  display_title: string;
  actor: { login: string };
}
export interface MaintenanceResult {
  status: string;
  repository: string;
  branch: string;
  run: string;
  pullRequest: string | null;
  head: string | null;
}
export interface PullRequest {
  merged: boolean;
  state: string;
  html_url: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}

export function validateResult(
  result: MaintenanceResult,
  repository: string,
  requestId: string,
  runUrl: string,
): number | null {
  if (
    result.status !== "success" ||
    result.repository?.toLowerCase() !== repository.toLowerCase() ||
    result.branch !== `codex/maintenance-${requestId}` ||
    result.run !== runUrl
  )
    throw new Error("maintenance result does not match this request");
  if (!result.pullRequest) return null;
  const expected = `https://github.com/${repository}/pull/`;
  if (
    !result.pullRequest.startsWith(expected) ||
    !/^[1-9]\d*$/.test(result.pullRequest.slice(expected.length)) ||
    !/^[a-f0-9]{40}$/.test(result.head ?? "")
  )
    throw new Error("maintenance result contains an invalid PR identity");
  return Number(result.pullRequest.slice(expected.length));
}

export function verifiedMerged(
  run: WorkflowRun,
  result: MaintenanceResult,
  pr: PullRequest,
  repository: string,
  requestId: string,
  runUrl: string,
  base: string,
): boolean {
  validateResult(result, repository, requestId, runUrl);
  return (
    run.status === "completed" &&
    run.conclusion === "success" &&
    result.pullRequest !== null &&
    pr.merged === true &&
    pr.state === "closed" &&
    pr.html_url === result.pullRequest &&
    pr.head.sha === result.head &&
    pr.head.ref === result.branch &&
    pr.base.ref === base &&
    pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase() &&
    pr.base.repo.full_name.toLowerCase() === repository.toLowerCase()
  );
}
