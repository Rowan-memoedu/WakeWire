import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { ProjectRegistration } from "../db/repos.js";
import type { DeliveryOptions, DeliveryResult } from "../sinks/types.js";

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const normalized = (value: string) => path.resolve(value).toLowerCase();

/** Supplied by an actual native executor, never recovered from a saved workflow owner. */
export function nativeCallerThreadId(env: NodeJS.ProcessEnv = process.env): string {
  return z.string().uuid().parse(env.CODEX_THREAD_ID);
}

/** Use the installed official app-tools MCP server; never edit application state ourselves. */
export class NativeProjectRegistry {
  private client: Client | undefined;
  private readonly registered = new Set<string>();
  constructor(
    private readonly injectedCall?: Call,
    private readonly ownerThreadId?: string,
  ) {}

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.injectedCall) return this.injectedCall(name, args);
    if (!this.ownerThreadId) throw new Error("native app-tools requires a caller Thread identity");
    if (!this.client) {
      const root = path.join(
        process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
        "plugins",
        "cache",
        "openai-bundled",
        "codex-app-tools",
      );
      const entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name, "server.mjs"))
        .filter((f) => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (!entries[0]) throw new Error("official Codex app-tools server is not installed");
      const pipe =
        process.env.CODEX_APP_TOOLS_PIPE_PATH ||
        (() => {
          if (process.platform !== "win32") throw new Error("Codex app-tools endpoint is missing");
          const names = fs
            .readdirSync("\\\\.\\pipe\\")
            .filter((n) => n.startsWith("codex-app-tools-"));
          if (names.length !== 1)
            throw new Error("expected one running Codex desktop app-tools endpoint");
          return `\\\\.\\pipe\\${names[0]}`;
        })();
      const client = new Client({ name: "wakewire-native-project", version: "1.0.0" });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [entries[0]],
            env: { ...env, CODEX_APP_TOOLS_PIPE_PATH: pipe },
            stderr: "ignore",
          }),
        );
        this.client = client;
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
    }
    const result = await this.client.callTool(
      { name, arguments: args, _meta: { "openai/threadId": this.ownerThreadId } },
      undefined,
      {
        timeout: 60_000,
      },
    );
    if (result.isError) throw new Error(`native app ${name} failed`);
    if (result.structuredContent) return result.structuredContent;
    const content = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(result.content);
    const text = content.find((item) => item.type === "text");
    if (!text?.text) throw new Error("native app returned no result");
    return JSON.parse(text.text);
  }

  async verifyProject(projectId: string, cwd: string): Promise<void> {
    const result = z
      .object({
        projects: z.array(
          z.object({
            projectId: z.string(),
            path: z.string().optional(),
            hostId: z.string().optional(),
          }),
        ),
      })
      .parse(await this.call("list_projects", {}));
    const project = result.projects.find((p) => p.projectId === projectId);
    if (
      !project?.path ||
      project.hostId !== "local" ||
      normalized(project.path) !== normalized(cwd)
    ) {
      throw new Error("native project identity, host or workspace differs");
    }
  }

  async register(
    threadId: string,
    projectId: string,
    cwd: string,
    afterRelease = false,
  ): Promise<void> {
    if (this.registered.has(threadId)) return;
    await this.verifyProject(projectId, cwd);
    if (afterRelease) {
      // A previous move may have succeeded before its receipt was saved.
      if (await this.hasProject(threadId, projectId, cwd)) return;
      z.object({ navigated: z.literal(true) }).parse(
        await this.call("navigate_to_codex_page", { threadId }),
      );
      const deadline = Date.now() + 15_000;
      while ((await this.readThread(threadId)).thread.status.type !== "idle") {
        if (Date.now() >= deadline) throw new Error("desktop has not loaded the released Thread");
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    const moved = z
      .object({ threadId: z.string(), projectId: z.string().nullable() })
      .parse(await this.call("move_thread_to_project", { threadId, projectId, hostId: "local" }));
    if (moved.threadId !== threadId || moved.projectId !== projectId)
      throw new Error("native project registration mismatch");
    if (!(await this.hasProject(threadId, projectId, cwd)))
      throw new Error("native project readback mismatch");
    this.registered.add(threadId);
  }

  private async hasProject(threadId: string, projectId: string, cwd: string): Promise<boolean> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = z
        .object({
          threads: z.array(
            z.object({
              id: z.string(),
              projectId: z.string().nullable().optional(),
              cwd: z.string().optional(),
            }),
          ),
          nextCursor: z.string().nullish(),
        })
        .parse(
          await this.call("list_threads", {
            mode: "history",
            source: "codex",
            hostId: "local",
            limit: 50,
            ...(cursor ? { cursor } : {}),
          }),
        );
      const thread = result.threads.find((t) => t.id === threadId);
      if (thread) {
        if (thread.cwd && normalized(thread.cwd) !== normalized(cwd))
          throw new Error("native project readback mismatch");
        return Boolean(thread.cwd) && thread.projectId === projectId;
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error("native thread pagination repeated");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return false;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  /** Read the existing app-owned Thread when no live caller turn can own a wait. */
  async readThread(threadId: string) {
    const snapshot = z
      .object({
        thread: z.object({
          id: z.string(),
          status: z.object({ type: z.string(), activeFlags: z.array(z.string()).optional() }),
        }),
        turns: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(
        await this.call("read_thread", {
          threadId,
          hostId: "local",
          turnLimit: 1,
          includeOutputs: false,
          maxOutputCharsPerItem: 100,
        }),
      );
    if (snapshot.thread.id !== threadId) throw new Error("native Thread readback identity differs");
    return { thread: snapshot.thread, latestTurn: snapshot.turns[0] };
  }

  /** Let the application's native create_thread tool own visibility and execution. */
  async startThread(
    prompt: string,
    projectId: string,
    cwd: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    await this.verifyProject(projectId, cwd);
    if (!this.ownerThreadId)
      throw new Error("native creation requires the current executor Thread");
    const caller = await this.readThread(this.ownerThreadId);
    if (caller.thread.status.type !== "active" || caller.latestTurn?.status !== "inProgress")
      throw new Error("native caller is not executing; creation was not attempted");
    opts.onSending?.();
    const created = z.object({ threadId: z.string(), hostId: z.string().optional() }).parse(
      await this.call("create_thread", {
        prompt,
        target: { type: "project", projectId, environment: { type: "local" } },
      }),
    );
    const threadId = created.threadId;
    if (created.hostId && created.hostId !== "local")
      throw new Error("native thread was created on an unexpected host");
    opts.onAccepted?.({ threadId });
    let turnId: string | undefined;
    let cursor: string | undefined;
    let useRead = false;
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      let raw: unknown;
      if (!useRead) {
        try {
          raw = await this.call("wait_threads", {
            targets: [{ threadId, hostId: "local", ...(cursor ? { afterCursor: cursor } : {}) }],
            timeoutMs: turnId ? 30_000 : 0,
          });
        } catch (error) {
          // Some app builds reject waits from a saved workflow owner context.
          // Read the same native Thread; never repeat create_thread or construct
          // another execution path.
          if ((error as { code?: number }).code !== -32000) throw error;
          useRead = true;
        }
      }
      if (useRead) raw = { polls: [await this.readThread(threadId)] };
      const snapshot = z
        .object({
          polls: z
            .array(
              z.object({
                cursor: z.string().optional(),
                latestTurn: z.object({ id: z.string(), status: z.string() }).nullable().optional(),
              }),
            )
            .optional(),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(raw);
      if (snapshot.errors?.length)
        throw new Error("native thread monitoring failed; identity retained");
      const poll = snapshot.polls?.[0];
      cursor = poll?.cursor ?? cursor;
      const turn = poll?.latestTurn;
      if (turn && !turnId) {
        turnId = turn.id;
        opts.onAccepted?.({ threadId, turnId });
      }
      if (turn && turn.id === turnId) {
        if (turn.status === "completed") return { threadId, turnId: turn.id };
        if (["failed", "interrupted"].includes(turn.status))
          throw new Error(`native turn ${turn.status}; identity retained`);
      }
      // Empty/inactive snapshots can return immediately; avoid a busy loop.
      if (useRead || !turnId || turn?.status !== "inProgress")
        await new Promise((resolve) => setTimeout(resolve, useRead && turnId ? 30_000 : 1000));
    }
    throw new Error("native turn monitoring timed out; identity retained");
  }
}

export async function registerReleasedThread(
  threadId: string,
  project: ProjectRegistration,
): Promise<void> {
  const registry = new NativeProjectRegistry(undefined, project.ownerThreadId);
  try {
    await registry.register(threadId, project.projectId, project.cwd, true);
  } finally {
    await registry.close();
  }
}
