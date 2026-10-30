import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import pino from "pino";
import { z } from "zod";
import { apiFetch, readDaemonState } from "../client.js";
import type { Route } from "../core/route.js";
import { createSecretStore, secretNames } from "../secrets/store.js";
import { VERSION } from "../version.js";
import {
  acknowledgeStarted,
  ensureQueued,
  type RemNode,
  type RemNoteReader,
  type RemPage,
  scanTodo,
  type TodoDispatcher,
  type TodoReceipt,
  taskPrompt,
} from "./remnote-todo.js";

const ConfigSchema = z.object({
  documentRemId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  cwd: z.string().min(1),
  mcpUrl: z.string().url(),
  wakewireHome: z.string().min(1),
  provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  sourceId: z.string().optional(),
  routeId: z.string().optional(),
  waitMinutes: z.number().int().min(1).max(1380).default(1320),
});
type Config = z.infer<typeof ConfigSchema>;

const NodeSchema = z.object({
  remId: z.string().min(1),
  title: z.string(),
  parentRemId: z.string().optional(),
  inlineRefs: z.array(z.object({ targetRemId: z.string(), text: z.string() })).optional(),
  media: z.array(z.unknown()).optional(),
});

function unwrap(result: unknown): unknown {
  const value = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };
  if (value.isError) throw new Error("RemNote MCP request failed");
  if (value.structuredContent) return value.structuredContent;
  const text = value.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("RemNote MCP returned no structured result");
  return JSON.parse(text);
}

class RemNoteMcp implements RemNoteReader {
  private readonly client = new Client({ name: "wakewire-remnote-todo", version: VERSION });
  async connect(url: string): Promise<void> {
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
      throw new Error("RemNote workflow requires a local MCP endpoint");
    }
    // SDK 1.x declares sessionId differently in its class and Transport interface.
    await this.client.connect(new StreamableHTTPClientTransport(parsed) as Transport);
    const status = (await this.call("remnote_status", {})) as {
      connected?: boolean;
      acceptWriteOperations?: boolean;
    };
    if (!status.connected || !status.acceptWriteOperations) {
      throw new Error("RemNote bridge is disconnected or write operations are disabled");
    }
  }
  async close(): Promise<void> {
    await this.client.close();
  }
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return unwrap(
      await this.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }),
    );
  }
  async children(parentRemId: string, cursor?: string): Promise<RemPage> {
    return z
      .object({
        children: z.array(NodeSchema),
        hasMore: z.boolean().optional(),
        nextCursor: z.string().optional(),
      })
      .parse(
        await this.call("remnote_list_children", {
          parentRemId,
          limit: 150,
          view: "full",
          ...(cursor ? { cursor } : {}),
        }),
      );
  }
  async read(remId: string): Promise<RemNode> {
    return NodeSchema.parse(
      await this.call("remnote_read_note", {
        remId,
        depth: 0,
        contentMode: "none",
        view: "full",
        includeMediaMetadata: true,
      }),
    );
  }
  async updateTitle(remId: string, title: string): Promise<void> {
    await this.call("remnote_update_note", { remId, title });
  }
}

async function api<T>(endpoint: string, body?: unknown): Promise<T> {
  const result = await apiFetch<T>(endpoint, body === undefined ? {} : { method: "POST", body });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`WakeWire API ${endpoint.split("?")[0]} returned HTTP ${result.status}`);
  }
  return result.body;
}

async function verifyDaemon(): Promise<void> {
  const health = await api<{ version: string; adapter: { name: string; codexReachable: boolean } }>(
    "/api/health",
  );
  if (health.version !== VERSION)
    throw new Error("WakeWire installed client and running daemon versions differ");
  if (health.adapter.name !== "codex-app-server" || !health.adapter.codexReachable) {
    throw new Error("RemNote workflow requires a reachable codex-app-server sink");
  }
}

async function setup(config: Config, configFile: string): Promise<void> {
  await verifyDaemon();
  const source = await api<{ sourceId: string }>("/api/sources/webhook/setup", {
    name: config.provider,
    mode: "listen",
    capture: 0,
    verification: {
      kind: "hmac-sha256",
      header: "x-wakewire-signature",
      prefix: "sha256=",
      encoding: "hex",
    },
    mapping: {
      deliveryId: "eventId",
      kind: "eventType",
      occurredAt: "occurredAt",
      summary: "RemNote marked task",
      fields: {
        documentRemId: "documentRemId",
        taskRemId: "taskRemId",
        contextRemId: "contextRemId",
      },
    },
  });
  const routeInput = {
    name: config.provider,
    source: "webhook",
    match: { provider: config.provider, events: ["todo.marked"] },
    target: { type: "new-thread", cwd: config.cwd, worktree: false },
    sandbox: "user-config",
    promptTemplate: taskPrompt(config.documentRemId),
    enabled: true,
  };
  const existing = (await api<{ routes: Route[] }>("/api/routes")).routes.filter(
    (route) => route.name === config.provider,
  );
  if (existing.length > 1) throw new Error("duplicate workflow routes need review");
  let route = existing[0];
  if (route) {
    for (const [key, expected] of Object.entries(routeInput)) {
      if (JSON.stringify(route[key as keyof Route]) !== JSON.stringify(expected)) {
        throw new Error(`existing workflow route differs at ${key}; no overwrite performed`);
      }
    }
  } else {
    route = (await api<{ route: Route }>("/api/routes", routeInput)).route;
  }
  fs.writeFileSync(
    configFile,
    `${JSON.stringify({ ...config, sourceId: source.sourceId, routeId: route.id }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      configured: true,
      routeId: route.id,
      sourceId: source.sourceId,
      dispatched: 0,
    }),
  );
}

async function createDispatcher(config: Config): Promise<TodoDispatcher> {
  const secrets = await createSecretStore(pino({ level: "silent" }));
  const sourceId = config.sourceId;
  const routeId = config.routeId;
  if (!sourceId || !routeId) throw new Error("run setup before scanning");
  const secret = secrets.get(secretNames.webhookSecret(sourceId));
  if (!secret) throw new Error("WakeWire signing secret unavailable");
  const route = (await api<{ routes: Route[] }>("/api/routes")).routes.find(
    (candidate) => candidate.id === routeId,
  );
  if (
    !route?.enabled ||
    route.target.type !== "new-thread" ||
    route.target.worktree ||
    route.target.cwd !== config.cwd ||
    route.sandbox !== "user-config" ||
    route.promptTemplate !== taskPrompt(config.documentRemId)
  ) {
    throw new Error("workflow route was disabled or changed; refusing to dispatch");
  }
  return {
    async receipt(sourceDeliveryId) {
      const query = new URLSearchParams({ routeId, sourceDeliveryId, limit: "1" });
      const result = await api<{ deliveries: TodoReceipt[] }>(`/api/deliveries?${query}`);
      return result.deliveries[0] ?? null;
    },
    async enqueue(task) {
      const state = readDaemonState();
      if (!state) throw new Error("WakeWire daemon unavailable");
      const body = JSON.stringify({
        eventId: task.sourceDeliveryId,
        eventType: "todo.marked",
        occurredAt: new Date().toISOString(),
        documentRemId: task.documentRemId,
        taskRemId: task.taskRemId,
        contextRemId: task.contextRemId,
      });
      const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
      const response = await fetch(`http://127.0.0.1:${state.port}/ingress/webhook/${sourceId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wakewire-signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`WakeWire ingress HTTP ${response.status}`);
    },
  };
}

interface RunReport {
  startedAt: string;
  finishedAt?: string;
  scanned: number;
  markedTasks: number;
  acknowledged: Array<{ remId: string; threadId: string; turnId: string }>;
  pending: string[];
  errors: Array<{ remId?: string; message: string }>;
}

async function run(config: Config, configFile: string): Promise<void> {
  const report: RunReport = {
    startedAt: new Date().toISOString(),
    scanned: 0,
    markedTasks: 0,
    acknowledged: [],
    pending: [],
    errors: [],
  };
  const reportFile = path.join(path.dirname(configFile), "last-run.json");
  const save = () =>
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const remnote = new RemNoteMcp();
  try {
    await verifyDaemon();
    await remnote.connect(config.mcpUrl);
    const dispatcher = await createDispatcher(config);
    const scan = await scanTodo(remnote, config.documentRemId, (scanned) =>
      console.log(JSON.stringify({ scanned })),
    );
    report.scanned = scan.nodeCount;
    report.markedTasks = scan.tasks.length;
    report.errors.push(
      ...scan.conflicts.map((remId) => ({
        remId,
        message: "overlapping parent/child % markers; left unchanged",
      })),
    );
    const pending = new Map(scan.tasks.map((task) => [task.taskRemId, task]));
    for (const task of scan.tasks) {
      await ensureQueued(dispatcher, task);
    }
    const deadline = Date.now() + config.waitMinutes * 60_000;
    let lastProgress = 0;
    while (pending.size && Date.now() < deadline) {
      for (const [remId, task] of pending) {
        const receipt = await dispatcher.receipt(task.sourceDeliveryId);
        if (receipt?.threadId && receipt.turnId) {
          try {
            const status = await acknowledgeStarted(remnote, task, receipt);
            if (status === "changed")
              throw new Error("source title changed after scan; left unchanged");
            report.acknowledged.push({ remId, threadId: receipt.threadId, turnId: receipt.turnId });
          } catch (error) {
            report.errors.push({
              remId,
              message: error instanceof Error ? error.message : "marker update failed",
            });
          }
          pending.delete(remId);
        } else if (receipt?.status === "failed" || receipt?.status === "coalesced") {
          report.errors.push({
            remId,
            message: `dispatch ${receipt.status}; inspect WakeWire receipt ${receipt.id}; no replay`,
          });
          pending.delete(remId);
        }
      }
      report.pending = [...pending.keys()];
      save();
      if (Date.now() - lastProgress > 60_000) {
        console.log(
          JSON.stringify({
            acknowledged: report.acknowledged.length,
            pending: pending.size,
            errors: report.errors.length,
          }),
        );
        lastProgress = Date.now();
      }
      if (pending.size) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    if (pending.size)
      report.errors.push({ message: "waiting window ended; receipts retained for the next scan" });
  } catch (error) {
    report.errors.push({ message: error instanceof Error ? error.message : "workflow failed" });
  } finally {
    await remnote.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    save();
  }
  console.log(
    JSON.stringify({
      scanned: report.scanned,
      markedTasks: report.markedTasks,
      acknowledged: report.acknowledged.length,
      pending: report.pending.length,
      errors: report.errors.length,
      reportFile,
    }),
  );
  if (report.errors.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, configFile] = process.argv.slice(2);
  if (!configFile || !["setup", "check", "run"].includes(command ?? "")) {
    throw new Error("usage: node remnote-todo-cli.js setup|check|run <absolute-config.json>");
  }
  const config = ConfigSchema.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
  if (
    !path.isAbsolute(configFile) ||
    !path.isAbsolute(config.cwd) ||
    !path.isAbsolute(config.wakewireHome)
  ) {
    throw new Error("workflow paths must be absolute");
  }
  process.env.WAKEWIRE_HOME = config.wakewireHome;
  if (command === "setup") return setup(config, configFile);
  if (command === "run") return run(config, configFile);
  await verifyDaemon();
  const remnote = new RemNoteMcp();
  try {
    await remnote.connect(config.mcpUrl);
    await createDispatcher(config);
    console.log(JSON.stringify({ ready: true, version: VERSION, scanned: 0, dispatched: 0 }));
  } finally {
    await remnote.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "RemNote workflow failed");
  process.exitCode = 1;
});
