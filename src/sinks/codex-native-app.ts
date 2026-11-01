import { NativeProjectRegistry } from "../workflows/native-project.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { PermanentError } from "./types.js";

/** Official app-tools MCP calls; no private Thread store or alternate creation path. */
export class CodexNativeAppAdapter implements AgentAdapter {
  readonly name = "codex-native-app";
  async probe(): Promise<boolean> {
    return true;
  }
  async deliverToThread(): Promise<DeliveryResult> {
    throw new PermanentError("native app adapter creates independent project threads only");
  }
  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    if (!opts.appProjectId || !opts.appOwnerThreadId || !opts.cwd)
      throw new PermanentError("native project delivery configuration is incomplete");
    const native = new NativeProjectRegistry(undefined, opts.appOwnerThreadId);
    try {
      return await native.startThread(prompt, opts.appProjectId, opts.cwd, opts);
    } finally {
      await native.close();
    }
  }
}
