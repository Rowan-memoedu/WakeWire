import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import readline from "node:readline";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type { Logger } from "../logging.js";

export const SessionHelloSchema = z.object({
  protocolVersion: z.literal(1),
  client: z.enum(["knowledge_clipper", "async_workflow"]),
  codexPath: z.string().min(1),
  cwd: z.string().min(1),
  configOverrides: z.array(z.string().max(4096)).max(64).default([]),
});
export type SessionHello = z.infer<typeof SessionHelloSchema>;

interface Session {
  client: string;
  close: () => Promise<void>;
}
type SessionSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/** Preserves the official SDK protocol; no task storage, prompt wrapping or replay. */
export class CodexSessionGateway {
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private readonly sessions = new Set<Session>();
  private stopping = false;

  constructor(
    private readonly token: string,
    private readonly allowedRuntimes: string[],
    private readonly logger: Logger,
    private readonly spawnChild: SessionSpawn = spawn,
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const expected = Buffer.from(`Bearer ${this.token}`);
      const received = Buffer.from(request.headers.authorization ?? "");
      if (
        this.stopping ||
        request.url !== "/api/codex/session" ||
        request.headers.origin ||
        received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
  }

  snapshot(): { activeSessions: number; clients: string[] } {
    return { activeSessions: this.sessions.size, clients: [...this.sessions].map((s) => s.client) };
  }

  async close(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.sessions].map((s) => s.close()));
    for (const socket of this.sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    const timer = setTimeout(() => socket.close(1008, "session setup timed out"), 10_000);
    socket.once("close", () => clearTimeout(timer));
    socket.on("error", () => socket.terminate());
    socket.once("message", (raw) => {
      clearTimeout(timer);
      try {
        const hello = SessionHelloSchema.parse(JSON.parse(raw.toString()));
        const runtime = fs.realpathSync(hello.codexPath);
        const normalize = (value: string) =>
          process.platform === "win32" ? value.toLowerCase() : value;
        if (
          !path.isAbsolute(hello.codexPath) ||
          !this.allowedRuntimes.some((candidate) => {
            try {
              return normalize(fs.realpathSync(candidate)) === normalize(runtime);
            } catch {
              return false;
            }
          }) ||
          !path.isAbsolute(hello.cwd) ||
          !fs.statSync(hello.cwd).isDirectory()
        ) {
          throw new Error("runtime or workspace is not allowed");
        }
        this.startSession(socket, { ...hello, codexPath: runtime });
      } catch {
        socket.close(1008, "invalid session setup or unapproved runtime");
      }
    });
  }

  private startSession(socket: WebSocket, hello: SessionHello): void {
    const args = hello.configOverrides.flatMap((value) => ["--config", value]);
    args.push("app-server", "--listen", "stdio://");
    const env = { ...process.env };
    for (const key of [
      "CODEX_APP_TOOLS_PIPE_PATH",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
      "CODEX_SESSION_ID",
      "CODEX_THREAD_ID",
      "CODEX_TOOL_CALL_ID",
      "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY",
    ])
      delete env[key];
    const child = this.spawnChild(hello.codexPath, args, {
      cwd: hello.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const id = crypto.randomUUID();
    const log = this.logger.child({ sessionId: id, client: hello.client, childPid: child.pid });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let closing: Promise<void> | undefined;
    const session: Session = {
      client: hello.client,
      close: () => {
        closing ??= (async () => {
          child.stdin.end();
          const force = setTimeout(() => child.kill(), 5_000);
          try {
            await closed;
          } finally {
            clearTimeout(force);
            this.sessions.delete(session);
            if (socket.readyState === WebSocket.OPEN) socket.close(1000);
            log.info("workflow session released");
          }
        })();
        return closing;
      },
    };
    this.sessions.add(session);
    // Drain native diagnostics without persisting private prompts or tool output.
    child.stderr.resume();
    child.stdin.on("error", () => void session.close());
    child.on("error", () => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "native runtime failed");
      void session.close();
    });
    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(line);
    });
    child.once("close", () => {
      output.close();
      if (!closing && socket.readyState === WebSocket.OPEN) {
        socket.close(1011, "native runtime exited");
      }
      void session.close();
    });
    socket.on("message", (raw) => {
      if (closing) return;
      const line = raw.toString();
      // Log method names only. All native input, identities and replies pass untouched.
      try {
        const message = JSON.parse(line) as { method?: string };
        if (message.method) log.info({ method: message.method }, "workflow native request");
      } catch {
        socket.close(1008, "invalid native JSON");
        return;
      }
      if (!child.stdin.write(`${line}\n`)) {
        socket.pause();
        child.stdin.once("drain", () => socket.resume());
      }
    });
    socket.once("close", () => void session.close());
    socket.send(JSON.stringify({ wakewire: "ready", protocolVersion: 1 }));
    log.info("workflow session opened");
  }
}
