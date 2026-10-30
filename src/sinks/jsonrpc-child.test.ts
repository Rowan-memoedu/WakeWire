import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { JsonRpcChild } from "./jsonrpc.js";

describe("owned child shutdown", () => {
  let client: JsonRpcChild | undefined;
  afterEach(() => client?.stop());

  async function start(endHandler: string): Promise<number> {
    const script = `
      const rl = require('node:readline').createInterface({input:process.stdin});
      rl.on('line', line => {
        const message=JSON.parse(line);
        process.stdout.write(JSON.stringify({id:message.id,result:{pid:process.pid}})+'\\n');
      });
      rl.on('close', () => { ${endHandler} });
    `;
    client = new JsonRpcChild(process.execPath, ["-e", script], pino({ level: "silent" }));
    client.start();
    return (await client.request<{ pid: number }>("initialize", {})).pid;
  }

  it("waits for a graceful EOF shutdown before returning", async () => {
    const pid = await start("setTimeout(() => process.exit(0), 100)");
    await client?.stopAndWait();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(client?.alive).toBe(false);
  });

  it("terminates only its owned child when graceful shutdown stalls", async () => {
    const pid = await start("setInterval(() => {}, 1000)");
    await client?.stopAndWait(30);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
