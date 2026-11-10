import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerAdapter } from "./codex-app-server.js";

interface Session {
  alive: boolean;
  released: boolean;
  args: string[];
  threadId: string;
  methods: string[];
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  complete(status?: string): void;
}
const harness = vi.hoisted(() => ({
  sessions: [] as Session[],
  autoComplete: true,
  rejectStart: false,
  readStatus: "inProgress",
}));

vi.mock("./jsonrpc.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./jsonrpc.js")>();
  class FakeChild {
    alive = false;
    released = false;
    threadId = `thread-${harness.sessions.length + 1}`;
    methods: string[] = [];
    requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    onNotification: ((method: string, params: unknown) => void) | null = null;
    onClose: ((error: Error) => void) | null = null;
    constructor(
      _command: string,
      readonly args: string[],
    ) {
      harness.sessions.push(this);
    }
    start() {
      this.alive = true;
    }
    stop() {
      this.alive = false;
      this.onClose?.(new Error("closed"));
    }
    async stopAndWait() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.stop();
      this.released = true;
    }
    notify() {}
    async request(method: string, params: Record<string, unknown>) {
      this.methods.push(method);
      this.requests.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") {
        if (typeof params.threadId === "string") this.threadId = params.threadId;
        return { thread: { id: this.threadId, status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        if (harness.rejectStart) throw new Error("turn rejected");
        if (harness.autoComplete) queueMicrotask(() => this.complete());
        return { turn: { id: `turn-${this.threadId}`, status: "inProgress" } };
      }
      if (method === "thread/read")
        return {
          thread: {
            id: this.threadId,
            turns: [{ id: `turn-${this.threadId}`, status: harness.readStatus }],
          },
        };
      return {};
    }
    complete(status = "completed") {
      this.onNotification?.("item/completed", {
        threadId: this.threadId,
        item: { type: "agentMessage", text: `response-${this.threadId}` },
      });
      this.onNotification?.("turn/completed", {
        threadId: this.threadId,
        turn: { id: `turn-${this.threadId}`, status, error: { message: "fixture failure" } },
      });
    }
  }
  return { ...original, JsonRpcChild: FakeChild };
});

describe("private app-server ownership", () => {
  let adapter: CodexAppServerAdapter;
  const options = { sandbox: "read-only" as const };
  beforeEach(() => {
    harness.sessions = [];
    harness.autoComplete = true;
    harness.rejectStart = false;
    harness.readStatus = "inProgress";
    adapter = new CodexAppServerAdapter(pino({ level: "silent" }), { connection: "spawn" });
  });
  afterEach(() => adapter.close());

  it.each(["completed", "interrupted"])(
    "reconciles a lost terminal notification: %s",
    async (status) => {
      vi.useFakeTimers();
      try {
        harness.autoComplete = false;
        harness.readStatus = status;
        const delivery = adapter.startThread("source", { ...options, privateAppServer: true });
        const result = delivery.then(
          () => "completed",
          () => "interrupted",
        );
        await vi.advanceTimersByTimeAsync(30_050);
        expect(await result).toBe(status);
        expect(harness.sessions[0]?.methods.filter((m) => m === "turn/start")).toHaveLength(1);
        expect(harness.sessions[0]?.methods).toContain("thread/read");
        expect(harness.sessions[0]?.released).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("waits for release before returning the completed thread and can handle the next event", async () => {
    const first = await adapter.startThread("first event", options);
    expect(first.finalResponse).toBe(`response-${first.threadId}`);
    expect(harness.sessions[0]?.released).toBe(true);
    const second = await adapter.startThread("independent event", options);
    expect(second.threadId).not.toBe(first.threadId);
    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions.every((session) => session.released && !session.alive)).toBe(true);
  });

  it("releases a completed concurrent delivery without interrupting the other", async () => {
    harness.autoComplete = false;
    const first = adapter.startThread("first", options);
    const second = adapter.startThread("second", options);
    await vi.waitFor(() => {
      expect(harness.sessions).toHaveLength(2);
      expect(harness.sessions.every((session) => session.methods.includes("turn/start"))).toBe(
        true,
      );
    });
    harness.sessions[0]?.complete();
    await first;
    expect(harness.sessions[0]?.released).toBe(true);
    expect(harness.sessions[1]?.alive).toBe(true);
    expect(harness.sessions[1]?.released).toBe(false);
    harness.sessions[1]?.complete();
    await second;
    expect(harness.sessions[1]?.released).toBe(true);
  });

  it("releases a resumed existing thread without changing its identity", async () => {
    const result = await adapter.deliverToThread("existing-thread", "follow up", options);
    expect(result.threadId).toBe("existing-thread");
    expect(harness.sessions[0]?.methods).toContain("thread/resume");
    expect(harness.sessions[0]?.released).toBe(true);
  });

  it.each(["failed", "interrupted"])("releases a %s turn", async (status) => {
    harness.autoComplete = false;
    const result = adapter.startThread("failure", options);
    const rejected = expect(result).rejects.toThrow(status);
    await vi.waitFor(() => expect(harness.sessions[0]?.methods).toContain("turn/start"));
    harness.sessions[0]?.complete(status);
    await rejected;
    expect(harness.sessions[0]?.released).toBe(true);
  });

  it("handles a rejected turn/start without an unhandled completion rejection", async () => {
    harness.rejectStart = true;
    await expect(adapter.startThread("reject", options)).rejects.toThrow("turn rejected");
    expect(harness.sessions[0]?.released).toBe(true);
  });

  it("does not retain a private process after a health probe", async () => {
    expect(await adapter.probe()).toBe(true);
    expect(harness.sessions[0]?.released).toBe(true);
  });

  it("preserves shared proxy lifecycle", async () => {
    adapter = new CodexAppServerAdapter(pino({ level: "silent" }), { connection: "proxy" });
    await adapter.startThread("shared", options);
    expect(harness.sessions[0]?.args).toEqual(["app-server", "proxy"]);
    expect(harness.sessions[0]?.alive).toBe(true);
    expect(harness.sessions[0]?.released).toBe(false);
  });

  it("reports creation and first-turn acceptance before the turn finishes", async () => {
    harness.autoComplete = false;
    const accepted = vi.fn();
    const sending = vi.fn();
    const result = adapter.startThread("marked task", {
      ...options,
      onSending: sending,
      onAccepted: accepted,
    });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2));
    expect(accepted.mock.calls[0]?.[0]).toEqual({ threadId: "thread-1" });
    expect(accepted.mock.calls[1]?.[0]).toEqual({ threadId: "thread-1", turnId: "turn-thread-1" });
    expect(sending).toHaveBeenCalledTimes(2);
    harness.sessions[0]?.complete();
    await result;
  });

  it("inherits existing Codex settings only on an explicit user-config route", async () => {
    await adapter.startThread("trusted local task", { sandbox: "user-config", cwd: "/workspace" });
    const requests =
      harness.sessions[0]?.requests.filter(
        ({ method }) => method === "thread/start" || method === "turn/start",
      ) ?? [];
    expect(requests).toHaveLength(2);
    for (const { params } of requests) {
      expect(params).not.toHaveProperty("sandbox");
      expect(params).not.toHaveProperty("sandboxPolicy");
      expect(params).not.toHaveProperty("approvalPolicy");
      expect(params).not.toHaveProperty("model");
    }
  });
});
