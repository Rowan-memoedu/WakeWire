import readline from "node:readline";
import WebSocket from "ws";
import { DaemonNotRunningError, readDaemonState } from "../client.js";
import type { SessionHello } from "../daemon/codex-sessions.js";

/** Official SDK launch_args_override entry: stdout contains only native JSON-RPC. */
export async function runCodexSession(hello: SessionHello): Promise<void> {
  const state = readDaemonState();
  if (!state) throw new DaemonNotRunningError("workflow session requires the configured daemon");
  const socket = new WebSocket(`ws://127.0.0.1:${state.port}/api/codex/session`, {
    headers: { Authorization: `Bearer ${state.token}` },
    maxPayload: 64 * 1024 * 1024,
    handshakeTimeout: 10_000,
  });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let input: readline.Interface | undefined;
    socket.on("open", () => socket.send(JSON.stringify(hello)));
    socket.on("message", (raw) => {
      if (!ready) {
        try {
          const ack = JSON.parse(raw.toString()) as { wakewire?: string; protocolVersion?: number };
          if (ack.wakewire !== "ready" || ack.protocolVersion !== 1) throw new Error();
        } catch {
          socket.close();
          reject(new Error("WakeWire session protocol mismatch"));
          return;
        }
        ready = true;
        input = readline.createInterface({ input: process.stdin });
        input.on("line", (line) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(line);
        });
        input.once("close", () => socket.close(1000));
        return;
      }
      if (!process.stdout.write(`${raw.toString()}\n`)) {
        socket.pause();
        process.stdout.once("drain", () => socket.resume());
      }
    });
    socket.once("error", () => reject(new DaemonNotRunningError("session connection failed")));
    socket.once("close", (code) => {
      input?.close();
      process.stdin.pause();
      if (ready && code === 1000) resolve();
      else
        reject(new Error(`WakeWire session closed (${code}); native requests were not replayed`));
    });
  });
}
