import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CodexSessionGateway } from "./codex-sessions.js";

describe("workflow native session transport", () => {
  let gateway: CodexSessionGateway;
  let server: Server;
  let url: string;
  let spawned = 0;
  const script = [
    "const rl=require('node:readline').createInterface({input:process.stdin});",
    "rl.on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,result:{message:m,pid:process.pid,inheritedThread:process.env.CODEX_THREAD_ID??null}})+'\\n')});",
    "rl.on('close',()=>setTimeout(()=>process.exit(0),40));",
  ].join("\n");

  beforeEach(async () => {
    spawned = 0;
    gateway = new CodexSessionGateway(
      "fixture-token",
      [process.execPath],
      pino({ level: "silent" }),
      (_command, _args, options) => {
        spawned++;
        return spawn(process.execPath, ["-e", script], options);
      },
    );
    server = createServer();
    gateway.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    url = `ws://127.0.0.1:${address.port}/api/codex/session`;
  });

  afterEach(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect(runtime = process.execPath) {
    const socket = new WebSocket(url, { headers: { Authorization: "Bearer fixture-token" } });
    await once(socket, "open");
    const response = once(socket, "message");
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        client: "knowledge_clipper",
        codexPath: runtime,
        cwd: process.cwd(),
        configOverrides: ['web_search="disabled"'],
      }),
    );
    await response;
    return socket;
  }

  async function echo(socket: WebSocket, message: unknown) {
    const response = once(socket, "message");
    socket.send(JSON.stringify(message));
    return JSON.parse(String((await response)[0]));
  }

  it("preserves long Unicode input, IDs, images, native instructions and model options", async () => {
    const socket = await connect();
    const input = {
      id: 17,
      method: "turn/start",
      params: {
        threadId: "existing-thread",
        model: "chosen-model",
        effort: "high",
        input: [
          { type: "text", text: "原文%\n".repeat(3000) },
          { type: "localImage", path: "D:/test/原图.png" },
        ],
      },
    };
    expect((await echo(socket, input)).result.message).toEqual(input);
    const instructions = {
      id: "native-string-id",
      method: "thread/inject_items",
      params: { threadId: "existing-thread", items: [{ role: "developer", text: "原有规则" }] },
    };
    expect((await echo(socket, instructions)).result.message).toEqual(instructions);
    socket.close();
    await expect.poll(() => gateway.snapshot().activeSessions).toBe(0);
  });

  it("releases a disconnected client without stopping another client's process", async () => {
    const first = await connect();
    const second = await connect();
    const a = (await echo(first, { id: 1, method: "thread/start", params: {} })).result.pid;
    const b = (await echo(second, { id: 1, method: "thread/resume", params: {} })).result.pid;
    first.terminate();
    await expect.poll(() => gateway.snapshot().activeSessions).toBe(1);
    expect(() => process.kill(a, 0)).toThrow();
    expect(() => process.kill(b, 0)).not.toThrow();
    expect((await echo(second, { id: 2, method: "turn/interrupt" })).id).toBe(2);
    second.close();
    await expect.poll(() => gateway.snapshot().activeSessions).toBe(0);
    expect(() => process.kill(b, 0)).toThrow();
  });

  it("awaits child exit when the daemon stops and never replays input", async () => {
    const socket = await connect();
    const pid = (await echo(socket, { id: 1, method: "thread/fork" })).result.pid;
    await gateway.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(spawned).toBe(1);
  });

  it("rejects missing authentication before starting a native process", async () => {
    const socket = new WebSocket(url);
    await expect(once(socket, "open")).rejects.toThrow();
    expect(spawned).toBe(0);
  });

  it("rejects an unapproved runtime without starting a native process", async () => {
    const socket = new WebSocket(url, { headers: { Authorization: "Bearer fixture-token" } });
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        client: "async_workflow",
        codexPath: process.cwd(),
        cwd: process.cwd(),
      }),
    );
    expect((await closed)[0]).toBe(1008);
    expect(spawned).toBe(0);
  });

  it("does not inherit a parent chat identity", async () => {
    const previous = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "must-not-inherit";
    try {
      const socket = await connect();
      expect(
        (await echo(socket, { id: 1, method: "initialize" })).result.inheritedThread,
      ).toBeNull();
      socket.close();
    } finally {
      if (previous === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previous;
    }
  });
});
