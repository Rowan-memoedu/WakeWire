import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { RemNoteMcp } from "./remnote-todo-cli.js";
import {
  type ArticleNode,
  type ArticlePublisher,
  type ArticleState,
  runArticles,
  scanArticles,
} from "./remnote-zhihu.js";

const Config = z.object({
  documentRemId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  mcpUrl: z.url(),
  python: z.string().min(1),
  cookieSnapshot: z.string().min(1),
  accountId: z.string().min(1),
});
type Config = z.infer<typeof Config>;

export class ZhihuPublisher implements ArticlePublisher {
  constructor(private readonly config: Config) {}
  private async call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const script = fileURLToPath(new URL("../../scripts/zhihu-client.py", import.meta.url));
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.python, ["-X", "utf8", script], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("Zhihu client timed out; never replay a publish"));
      }, 90000);
      child.on("error", () => finish(new Error("Zhihu client could not start")));
      child.stdin.on("error", () => finish(new Error("Zhihu client input failed")));
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
        if (stdout.length > 2000000) {
          child.kill();
          finish(new Error("Zhihu client response too large"));
        }
      });
      child.stderr.resume(); // Upstream exceptions must never leak credentials or HTTP response bodies.
      child.on("close", (code) => {
        try {
          const result = JSON.parse(stdout) as { ok: boolean; data: T; error?: string };
          if (!result.ok || code !== 0)
            return finish(
              new Error(
                `Zhihu client failed: ${/^[A-Za-z_]+$/u.test(result.error ?? "") ? result.error : "invalid_response"}`,
              ),
            );
          finish(undefined, result.data);
        } catch {
          finish(new Error("Zhihu client returned invalid JSON"));
        }
      });
      child.stdin.end(
        JSON.stringify({
          action,
          snapshotPath: this.config.cookieSnapshot,
          expectedAccountId: this.config.accountId,
          ...args,
        }),
      );
    });
  }
  prepare(
    nodes: ArticleNode[],
  ): Promise<{ title: string; html: string; text: string; format: string }> {
    return this.call("prepare", { nodes });
  }
  check(): Promise<{ id: string; name: string; urlToken: string }> {
    return this.call("check");
  }
  publish(title: string, html: string): Promise<{ id: string }> {
    return this.call("publish", { title, html });
  }
  verify(articleId: string): Promise<{
    id: string;
    authorId: string;
    title: string;
    text: string;
    format: string;
    url: string;
  }> {
    return this.call("verify", { articleId });
  }
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
}

function lock(file: string): () => void {
  try {
    const descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    fs.closeSync(descriptor);
    return () => fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = z
      .object({ pid: z.number().int().positive() })
      .parse(JSON.parse(fs.readFileSync(file, "utf8")));
    try {
      process.kill(previous.pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
        fs.unlinkSync(file);
        return lock(file);
      }
      throw probe;
    }
    throw new Error("another Zhihu workflow process owns the lock");
  }
}

function readState(file: string): ArticleState {
  if (!fs.existsSync(file)) return { receipts: [] };
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as ArticleState;
  if (!Array.isArray(state.receipts)) throw new Error("invalid article state");
  for (const r of state.receipts) {
    if (
      !r.source?.remId ||
      !r.source.parentRemId ||
      !r.source.fingerprint ||
      !r.source.nodes?.length ||
      !r.html ||
      !r.text ||
      !r.title ||
      !r.format ||
      !r.slot ||
      !["submitting", "published", "verified", "archived"].includes(r.stage) ||
      (r.stage !== "submitting" && !/^\d+$/u.test(r.articleId ?? ""))
    )
      throw new Error("invalid article receipt; state was preserved");
  }
  return state;
}

async function main(): Promise<void> {
  const [action, configFile] = process.argv.slice(2);
  if (
    !action ||
    !["check", "scan", "preview", "run"].includes(action) ||
    !configFile ||
    !path.isAbsolute(configFile)
  )
    throw new Error("usage: remnote-zhihu-cli.js check|scan|preview|run <absolute-config.json>");
  const config = Config.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
  for (const target of [config.python, config.cookieSnapshot])
    if (!path.isAbsolute(target)) throw new Error("runtime paths must be absolute");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.mcpUrl).hostname))
    throw new Error("RemNote endpoint must be loopback");
  const home = path.dirname(configFile);
  const release = action === "run" ? lock(path.join(home, "run.lock")) : () => {};
  const remnote = new RemNoteMcp();
  try {
    await remnote.connect(config.mcpUrl);
    const publisher = new ZhihuPublisher(config);
    if (action === "run") {
      const stateFile = path.join(home, "state.json");
      const state = readState(stateFile);
      const result = await runArticles({
        remnote,
        publisher,
        documentRemId: config.documentRemId,
        accountId: config.accountId,
        state,
        save: () => atomicJson(stateFile, state),
        now: new Date(),
      });
      atomicJson(path.join(home, "last-run.json"), { at: new Date().toISOString(), ...result });
      console.log(JSON.stringify(result));
      return;
    }
    const scan = await scanArticles(remnote, config.documentRemId);
    const result: Record<string, unknown> = {
      ready: true,
      scanned: scan.nodeCount,
      pending: scan.sources.length,
      blocked: scan.blocked.length,
      published: 0,
      moved: 0,
    };
    if (action === "check") {
      const account = await publisher.check();
      if (account.id !== config.accountId)
        throw new Error("configured account does not match current login");
      result.account = { name: account.name, urlToken: account.urlToken };
    }
    if (action === "preview" && scan.sources[0]) {
      const source = scan.sources[0];
      const prepared = await publisher.prepare(source.nodes);
      const file = path.join(home, "preview.html");
      fs.writeFileSync(
        file,
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>知乎文章预览</title><style>body{max-width:720px;margin:40px auto;padding:0 20px;font:18px/1.8 system-ui}li{margin:8px 0}</style><h1>${prepared.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</h1>${prepared.html}</html>`,
        { mode: 0o600 },
      );
      atomicJson(path.join(home, "preview.json"), {
        sourceRemId: source.remId,
        fingerprint: source.fingerprint,
        ...prepared,
      });
      result.previewFile = file;
      result.characters = prepared.text.length;
      result.nodes = source.nodes.length;
    }
    console.log(JSON.stringify(result));
  } finally {
    await remnote.close();
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Zhihu workflow failed");
    process.exitCode = 1;
  });
