import { describe, expect, it, vi } from "vitest";
import { NativeProjectRegistry } from "./native-project.js";

describe("official app project registration", () => {
  it("recovers a background wait failure by reading the same accepted Thread", async () => {
    const calls: string[] = [];
    const accepted: unknown[] = [];
    const registry = new NativeProjectRegistry(async (name) => {
      calls.push(name);
      if (name === "list_projects")
        return { projects: [{ projectId: "saved", path: "D:/work", hostId: "local" }] };
      if (name === "create_thread") return { threadId: "visible", hostId: "local" };
      if (name === "wait_threads")
        throw Object.assign(new Error("app request failed"), { code: -32000 });
      return {
        thread: { id: "visible", status: { type: "idle" } },
        turns: [{ id: "accepted-turn", status: "completed" }],
      };
    });
    expect(
      await registry.startThread("原任务", "saved", "D:/work", {
        sandbox: "user-config",
        onAccepted: (value) => accepted.push(value),
      }),
    ).toEqual({ threadId: "visible", turnId: "accepted-turn" });
    expect(calls).toEqual(["list_projects", "create_thread", "wait_threads", "read_thread"]);
    expect(accepted).toEqual([
      { threadId: "visible" },
      { threadId: "visible", turnId: "accepted-turn" },
    ]);
  });

  it("uses the native visible project create tool with the exact original prompt and accepted turn receipts", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const accepted: unknown[] = [];
    let release: (() => void) | undefined;
    let polls = 0;
    const registry = new NativeProjectRegistry(async (name, args) => {
      calls.push({ name, args });
      if (name === "list_projects")
        return { projects: [{ projectId: "saved", path: "D:/work", hostId: "local" }] };
      if (name === "create_thread") return { threadId: "visible", hostId: "local" };
      if (++polls > 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        polls: [
          {
            cursor: String(polls),
            latestTurn: { id: "accepted-turn", status: polls === 1 ? "inProgress" : "completed" },
          },
        ],
      };
    });
    const result = registry.startThread("原始任务\n  - 完整内容", "saved", "D:/work", {
      sandbox: "user-config",
      onAccepted: (r) => accepted.push(r),
    });
    await vi.waitFor(() =>
      expect(accepted).toEqual([
        { threadId: "visible" },
        { threadId: "visible", turnId: "accepted-turn" },
      ]),
    );
    expect(calls.find((c) => c.name === "create_thread")?.args).toEqual({
      prompt: "原始任务\n  - 完整内容",
      target: { type: "project", projectId: "saved", environment: { type: "local" } },
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release?.();
    expect(await result).toEqual({ threadId: "visible", turnId: "accepted-turn" });
  });
  it("registers the existing native identity and checks paginated app membership", async () => {
    const calls: string[] = [];
    const registry = new NativeProjectRegistry(async (name, args) => {
      calls.push(name);
      if (name === "list_projects")
        return { projects: [{ projectId: "saved", path: "D:/work", hostId: "local" }] };
      if (name === "move_thread_to_project")
        return { threadId: args.threadId, projectId: args.projectId };
      if (!args.cursor) return { threads: [], nextCursor: "next" };
      return {
        threads: [{ id: "existing", projectId: "saved", cwd: "D:/work" }],
        nextCursor: null,
      };
    });
    await registry.register("existing", "saved", "D:/work");
    await registry.register("existing", "saved", "D:/work");
    expect(calls).toEqual([
      "list_projects",
      "move_thread_to_project",
      "list_threads",
      "list_threads",
    ]);
  });
  it("rejects a mismatched workspace before changing the app", async () => {
    const calls: string[] = [];
    const registry = new NativeProjectRegistry(async (name) => {
      calls.push(name);
      return { projects: [{ projectId: "saved", path: "D:/different", hostId: "local" }] };
    });
    await expect(registry.register("existing", "saved", "D:/work")).rejects.toThrow("differs");
    expect(calls).toEqual(["list_projects"]);
  });
  it("rejects a successful mutation whose native readback has no project membership", async () => {
    const registry = new NativeProjectRegistry(async (name) => {
      if (name === "list_projects")
        return { projects: [{ projectId: "saved", path: "D:/work", hostId: "local" }] };
      if (name === "move_thread_to_project") return { threadId: "existing", projectId: "saved" };
      return { threads: [{ id: "existing", projectId: null, cwd: "D:/work" }] };
    });
    await expect(registry.register("existing", "saved", "D:/work")).rejects.toThrow(
      "readback mismatch",
    );
  });
});
