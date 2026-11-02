import type { SandboxPolicy } from "../core/route.js";

export interface DeliveryOptions {
  appProjectId?: string | undefined;
  appOwnerThreadId?: string | undefined;
  /** A dedicated App Server owns the first turn until the native completion notification. */
  privateAppServer?: boolean;
  sandbox: SandboxPolicy;
  /** Working directory override (used for new threads; ignored for resume by some adapters). */
  cwd?: string | undefined;
  /** Persist intent before an RPC can create a thread/turn. */
  onSending?: (() => void) | undefined;
  /** Persist identities as soon as the server acknowledges them. */
  onAccepted?: ((result: DeliveryResult) => void) | undefined;
}

export interface DeliveryResult {
  threadId: string;
  turnId?: string | undefined;
  /** Final agent message when the adapter runs the turn to completion (SDK/exec adapters). */
  finalResponse?: string | undefined;
}

/**
 * The one seam between wakewire and any coding agent. v1 ships Codex
 * implementations only; a Claude Code adapter would implement this interface.
 */
export interface AgentAdapter {
  readonly name: string;
  /** Append a turn to an existing thread. */
  deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /** Start a new thread in opts.cwd and send the prompt as its first turn. */
  startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /** Cheap reachability check — used to decide held-vs-failed and for status reporting. */
  probe(): Promise<boolean>;
  /** Release connections/child processes on daemon shutdown. */
  close?(): void;
}

/** The target thread has a turn in flight. Retry later; never a failure. */
export class BusyError extends Error {}

/** Codex (app-server or CLI) is not reachable. Retry with backoff, forever. */
export class UnreachableError extends Error {}

/** Delivery can never succeed (unknown thread, invalid target). Fail immediately. */
export class PermanentError extends Error {}
