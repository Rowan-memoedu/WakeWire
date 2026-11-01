import pino from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { DeliveryQueue } from "../core/queue.js";
import type { Route } from "../core/route.js";
import { matchRoutes } from "../core/router.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { AgentAdapter } from "../sinks/types.js";
import { createApi } from "./api.js";
import { SourceManager } from "./sources.js";

function fixture() {
  const db = openDatabase(":memory:");
  const stores = createStores(db);
  const config = loadConfig(stores.settings);
  const logger = pino({ level: "silent" });
  const calls: string[] = [];
  const secrets = { backend: "file" as const, get: () => null, set: () => {}, delete: () => {} };
  const adapter: AgentAdapter = {
    name: "fake",
    probe: async () => true,
    async deliverToThread() {
      throw new Error("expected a new thread");
    },
    async startThread(prompt, opts) {
      calls.push(prompt);
      opts.onSending?.();
      const receipt = { threadId: `thread-${calls.length}`, turnId: `turn-${calls.length}` };
      opts.onAccepted?.(receipt);
      return receipt;
    },
  };
  const queue = new DeliveryQueue(stores, adapter, logger, { autoWake: false });
  const sources = new SourceManager(stores, secrets, logger, () => {});
  const app = createApi({
    stores,
    config,
    logger,
    queue,
    sources,
    secrets,
    adapter,
    startedAt: "fixture",
  });
  const headers = {
    authorization: `Bearer ${config.apiToken}`,
    "content-type": "application/json",
  };
  const input = {
    name: "local-source",
    source: "webhook",
    match: { provider: "local-source" },
    target: { type: "new-thread", cwd: "/fixture", worktree: false, promptMode: "verbatim" },
    sandbox: "user-config",
    enabled: true,
  };
  return { db, stores, queue, calls, app, headers, input };
}

describe("verbatim local prompt delivery", () => {
  it("requires and preserves the actual executor for native prompts instead of the saved owner", async () => {
    const f = fixture();
    try {
      const created = await f.app.request("/api/routes", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({
          ...f.input,
          target: {
            ...f.input.target,
            appProjectId: "saved-project",
            appOwnerThreadId: "stale-owner",
          },
        }),
      });
      const { route } = (await created.json()) as { route: Route };
      const input = { sourceDeliveryId: "current-execution", prompt: "unchanged original" };
      const missing = await f.app.request(`/api/routes/${route.id}/prompts`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify(input),
      });
      expect(missing.status).toBe(400);
      expect(f.stores.deliveries.list({})).toHaveLength(0);
      const caller = "b4f9d401-9061-4ba4-9c9a-8dcb777f2b3e";
      const accepted = await f.app.request(`/api/routes/${route.id}/prompts`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ ...input, nativeCallerThreadId: caller }),
      });
      expect(accepted.status).toBe(202);
      expect(f.stores.deliveries.list({})[0]).toMatchObject({
        renderedPrompt: input.prompt,
        event: { payload: { nativeCallerThreadId: caller } },
      });
    } finally {
      f.db.close();
    }
  });

  it("authenticates, preserves the full prompt and deduplicates without an event envelope", async () => {
    const f = fixture();
    try {
      const created = await f.app.request("/api/routes", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify(f.input),
      });
      expect(created.status).toBe(201);
      const { route } = (await created.json()) as { route: Route };
      const prompt = `- 原文第一行\n  - ${"保留长文本、换行、数字 123 和 $x^2$。".repeat(1500)}\n  - 原文最后一行`;
      const body = JSON.stringify({ sourceDeliveryId: "source-1", prompt });
      const denied = await f.app.request(`/api/routes/${route.id}/prompts`, {
        method: "POST",
        body,
      });
      expect(denied.status).toBe(401);
      const accepted = await f.app.request(`/api/routes/${route.id}/prompts`, {
        method: "POST",
        headers: f.headers,
        body,
      });
      expect(accepted.status).toBe(202);
      await f.queue.tick();
      expect(f.calls).toEqual([prompt]);
      expect(f.stores.deliveries.list({})[0]?.renderedPrompt).toBe(prompt);
      await f.app.request(`/api/routes/${route.id}/prompts`, {
        method: "POST",
        headers: f.headers,
        body,
      });
      await f.queue.tick();
      expect(f.calls).toEqual([prompt]);
      expect(
        matchRoutes([route], {
          source: "webhook",
          kind: "event",
          deliveryId: "remote",
          occurredAt: "now",
          summary: "",
          payload: { provider: "local-source" },
        }),
      ).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it("upgrades the route in place while preserving every old delivery field", async () => {
    const f = fixture();
    try {
      const old = f.stores.routes.create({
        name: "local-source",
        source: "webhook",
        match: { provider: "local-source" },
        target: { type: "new-thread", cwd: "/fixture", worktree: false },
        promptTemplate: "old instructions",
        sandbox: "user-config",
        enabled: true,
      });
      const delivery = f.stores.deliveries.enqueue({
        routeId: old.id,
        event: {
          source: "webhook",
          kind: "event",
          deliveryId: "old-event",
          occurredAt: "now",
          summary: "old",
          payload: {},
        },
        renderedPrompt: "old original input",
      });
      f.stores.deliveries.markDelivered(delivery?.id ?? "", {
        threadId: "previous-thread",
        turnId: "previous-turn",
      });
      const before = f.stores.deliveries.get(delivery?.id ?? "");
      const source = f.stores.sources.upsert({
        id: "legacy-source",
        kind: "webhook",
        config: { name: "local-source" },
      });
      const updated = await f.app.request(`/api/routes/${old.id}`, {
        method: "PUT",
        headers: f.headers,
        body: JSON.stringify(f.input),
      });
      expect(updated.status).toBe(200);
      expect(f.stores.routes.get(old.id)?.promptTemplate).toBeNull();
      const disabled = await f.app.request(`/api/sources/${source.id}/toggle`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ enabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect(f.stores.sources.get(source.id)).toEqual({ ...source, enabled: false });
      expect(f.stores.deliveries.get(delivery?.id ?? "")).toEqual(before);
      expect(f.stores.routes.list()).toHaveLength(1);
      expect(f.calls).toEqual([]);
    } finally {
      f.db.close();
    }
  });
});
