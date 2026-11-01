import { describe, expect, it } from "vitest";
import {
  type MaintenanceResult,
  type PullRequest,
  validateResult,
  verifiedMerged,
  type WorkflowRun,
} from "./github-maintenance.js";
import {
  MaintenanceConfigSchema,
  type MaintenanceReceipt,
  maintenanceRequestId,
} from "./maintenance-types.js";
import {
  ensureBuckets,
  placeCompleted,
  placeStarted,
  taskFingerprint,
  writeFeedback,
} from "./remnote-maintenance.js";
import { type RemNode, type RemNoteReader, scanTodo } from "./remnote-todo.js";

function fixture(initial: RemNode[]) {
  const nodes = new Map(initial.map((n) => [n.remId, structuredClone(n)]));
  const remnote: RemNoteReader = {
    async read(id) {
      const node = nodes.get(id);
      if (!node) throw new Error("missing node");
      return structuredClone(node);
    },
    async children(id, cursor) {
      const all = [...nodes.values()].filter((n) => n.parentRemId === id);
      const start = Number(cursor ?? 0);
      return {
        children: all.slice(start, start + 2).map((n) => structuredClone(n)),
        hasMore: start + 2 < all.length,
        nextCursor: String(start + 2),
      };
    },
    async create(parentRemId, title) {
      const id = `new-${nodes.size}`;
      nodes.set(id, { remId: id, title, parentRemId });
      return id;
    },
    async updateTitle(id, title) {
      const node = nodes.get(id) as RemNode;
      node.title = title;
      if (node.headline !== undefined) node.headline = title;
    },
    async move(id, parentRemId, expected, position = "last", sibling) {
      const node = nodes.get(id) as RemNode;
      if (node.parentRemId !== expected) throw new Error("stale parent");
      nodes.delete(id);
      node.parentRemId = parentRemId;
      const entries = [...nodes.entries()];
      const index = entries.findIndex(([key]) => key === sibling);
      if (position === "last") entries.push([id, node]);
      else entries.splice(index + (position === "after" ? 1 : 0), 0, [id, node]);
      nodes.clear();
      for (const [key, value] of entries) nodes.set(key, value);
    },
  };
  return { nodes, remnote };
}

describe("RemNote maintenance lifecycle", () => {
  it("moves the original paginated subtree exactly once, preserves text and keeps receipt feedback outside the fingerprint", async () => {
    const f = fixture([
      { remId: "doc", title: "项目", remType: "document", parentRemId: "root" },
      { remId: "task", title: "%修复\n第二行", parentRemId: "doc" },
      ...[1, 2, 3].map((n) => ({
        remId: `detail-${n}`,
        title: `$x_${n}$ 与代码`,
        parentRemId: "task",
      })),
    ]);
    const buckets = await ensureBuckets(f.remnote, "doc");
    expect(await ensureBuckets(f.remnote, "doc")).toEqual(buckets);
    const receipt: MaintenanceReceipt = {
      revision: 0,
      documentRemId: "doc",
      taskRemId: "task",
      originalTitle: "%修复\n第二行",
      requestId: "stable",
      fingerprint: await taskFingerprint(f.remnote, "task"),
      started: false,
      completed: false,
    };
    await expect(placeStarted(f.remnote, receipt, buckets.started)).rejects.toThrow("acknowledged");
    receipt.runId = 42;
    receipt.runUrl = "https://github.com/owner/hub/actions/runs/42";
    await placeStarted(f.remnote, receipt, buckets.started);
    await placeStarted(f.remnote, receipt, buckets.started);
    expect(f.nodes.get("task")?.title).toBe("修复\n第二行");
    receipt.started = true;
    receipt.feedbackRemId = await writeFeedback(f.remnote, receipt, "等待审核合并 PR");
    expect(await taskFingerprint(f.remnote, "task", receipt.feedbackRemId)).toBe(
      receipt.fingerprint,
    );
    await placeCompleted(f.remnote, receipt, buckets.started, buckets.completed);
    await placeCompleted(f.remnote, receipt, buckets.started, buckets.completed);
    expect(f.nodes.get("task")?.parentRemId).toBe(buckets.completed);
    expect(f.nodes.get("detail-3")).toEqual({
      remId: "detail-3",
      title: "$x_3$ 与代码",
      parentRemId: "task",
    });
    expect((await f.remnote.children("task")).children[0]?.remId).toBe("detail-1");
  });

  it("does not archive new source edits, and excludes mapped documents from ordinary To Do intake", async () => {
    const f = fixture([
      { remId: "project", title: "项目", parentRemId: "root", remType: "document" },
      { remId: "task", title: "%代码任务", parentRemId: "project" },
      { remId: "ordinary", title: "%普通事项", parentRemId: "root" },
    ]);
    const scan = await scanTodo(f.remnote, "root", () => {}, new Set(["project"]));
    expect(scan.tasks.map((task) => task.taskRemId)).toEqual(["ordinary"]);
    const buckets = await ensureBuckets(f.remnote, "project");
    const frozen = (await scanTodo(f.remnote, "project")).tasks[0]?.subtreeFingerprint;
    expect(frozen).toBe(await taskFingerprint(f.remnote, "task"));
    const receipt: MaintenanceReceipt = {
      revision: 0,
      documentRemId: "project",
      taskRemId: "task",
      originalTitle: "%代码任务",
      requestId: "stable",
      fingerprint: await taskFingerprint(f.remnote, "task"),
      started: false,
      completed: false,
      runId: 1,
    };
    await placeStarted(f.remnote, receipt, buckets.started);
    receipt.started = true;
    await f.remnote.create("task", "%新增需求");
    expect(await taskFingerprint(f.remnote, "task")).not.toBe(frozen);
    await expect(
      placeCompleted(f.remnote, receipt, buckets.started, buckets.completed),
    ).rejects.toThrow("content changed");
    expect(f.nodes.get("task")?.parentRemId).toBe(buckets.started);
  });

  it("requires successful execution and the exact reviewed head to be merged into the target default branch", () => {
    const repository = "owner/project",
      requestId = "rn-canary",
      url = "https://github.com/owner/hub/actions/runs/42";
    const run = { status: "completed", conclusion: "success" } as WorkflowRun;
    const result: MaintenanceResult = {
      status: "success",
      repository,
      branch: `codex/maintenance-${requestId}`,
      run: url,
      pullRequest: "https://github.com/owner/project/pull/3",
      head: "a".repeat(40),
    };
    const pr: PullRequest = {
      merged: true,
      state: "closed",
      html_url: result.pullRequest as string,
      head: { sha: result.head as string, ref: result.branch, repo: { full_name: repository } },
      base: { ref: "main", repo: { full_name: repository } },
    };
    const check = (r = run, p = pr) =>
      verifiedMerged(r, result, p, repository, requestId, url, "main");
    expect(check()).toBe(true);
    expect(check({ ...run, conclusion: "failure" })).toBe(false);
    expect(check(run, { ...pr, merged: false })).toBe(false);
    expect(check(run, { ...pr, head: { ...pr.head, sha: "b".repeat(40) } })).toBe(false);
    expect(check(run, { ...pr, base: { ...pr.base, ref: "other" } })).toBe(false);
    expect(() =>
      validateResult({ ...result, repository: "owner/other" }, repository, requestId, url),
    ).toThrow("does not match");
    expect(validateResult({ ...result, pullRequest: null }, repository, requestId, url)).toBeNull();
  });

  it("rejects ambiguous configuration and gives independent stable request IDs", () => {
    const config = {
      hub: "owner/hub",
      mcpUrl: "http://localhost:3000/mcp",
      wakewireHome: "D:/data",
      resultRoot: "D:/results",
      legacyDocumentRemId: "root",
      legacyRouteId: "legacy",
      bindings: [
        { documentRemId: "a", title: "A", repository: "owner/project" },
        { documentRemId: "b", title: "B", repository: "owner/PROJECT" },
      ],
    };
    expect(() => MaintenanceConfigSchema.parse(config)).toThrow("one-to-one");
    expect(maintenanceRequestId("a", "one")).toBe(maintenanceRequestId("a", "one"));
    expect(maintenanceRequestId("a", "one")).not.toBe(maintenanceRequestId("b", "one"));
  });
});
