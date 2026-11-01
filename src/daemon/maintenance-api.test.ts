import pino from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { DeliveryQueue } from "../core/queue.js";
import type { Route } from "../core/route.js";
import { matchRoutes } from "../core/router.js";
import { openDatabase } from "../db/db.js";
import { createStores, type Delivery } from "../db/repos.js";
import type { AgentAdapter } from "../sinks/types.js";
import { createApi } from "./api.js";
import { SourceManager } from "./sources.js";

function fixture() {
  const db = openDatabase(":memory:");
  const stores = createStores(db);
  const config = loadConfig(stores.settings);
  const logger = pino({ level: "silent" });
  const secrets = { backend: "file" as const, get: () => null, set: () => {}, delete: () => {} };
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    name: "fixture",
    probe: async () => true,
    startThread: async () => {
      calls.push("unexpected");
      return { threadId: "wrong" };
    },
    deliverToThread: async () => {
      calls.push("unexpected");
      return { threadId: "wrong" };
    },
  };
  const queue = new DeliveryQueue(stores, adapter, logger, { autoWake: false });
  const app = createApi({
    stores,
    config,
    logger,
    secrets,
    adapter,
    queue,
    sources: new SourceManager(stores, secrets, logger, () => {}),
    startedAt: "fixture",
  });
  const headers = {
    authorization: `Bearer ${config.apiToken}`,
    "content-type": "application/json",
  };
  const input = {
    name: "fixture",
    source: "webhook",
    match: { provider: "remnote-maintenance" },
    target: {
      type: "github-actions",
      repository: "owner/project",
      hub: "owner/hub",
      workflow: "maintenance.yml",
      ref: "main",
      documentRemId: "document",
    },
    sandbox: "read-only",
    enabled: true,
  };
  const post = (url: string, body: unknown, method = "POST") =>
    app.request(url, { method, headers, body: JSON.stringify(body) });
  return { db, stores, queue, app, calls, input, post };
}

describe("Actions intake on the existing delivery ledger", () => {
  it("authenticates, reserves once, survives an unknown result without entering Codex, and keeps run identity", async () => {
    const f = fixture();
    try {
      const { route } = (await (await f.post("/api/routes", f.input)).json()) as { route: Route };
      const url = `/api/routes/${route.id}/maintenance`;
      const request = {
        taskRemId: "task",
        originalTitle: "%保留 `代码`",
        prompt: "- 保留 `代码`\n  - 换行和 $x^2$",
        fingerprint: "a".repeat(64),
      };
      expect(
        (await f.app.request(url, { method: "POST", body: JSON.stringify(request) })).status,
      ).toBe(401);
      const first = (await (await f.post(url, request)).json()) as {
        delivery: Delivery;
        created: boolean;
      };
      expect(first.created).toBe(true);
      expect(first.delivery.renderedPrompt).toBe(request.prompt);
      expect(first.delivery.threadId).toBeNull();
      f.stores.deliveries.resetInFlight();
      const duplicate = (await (await f.post(url, request)).json()) as typeof first;
      expect(duplicate.created).toBe(false);
      expect(duplicate.delivery.id).toBe(first.delivery.id);
      await f.queue.tick();
      expect(f.calls).toEqual([]);
      const endpoint = `/api/deliveries/${first.delivery.id}/maintenance`;
      expect((await f.post(endpoint, { revision: 0, started: true }, "PATCH")).status).toBe(409);
      expect((await f.post(endpoint, { revision: 0, runId: 42 }, "PATCH")).status).toBe(200);
      expect((await f.post(endpoint, { revision: 0, started: true }, "PATCH")).status).toBe(409);
      expect((await f.post(endpoint, { revision: 1, runId: 43 }, "PATCH")).status).toBe(409);
      expect((await f.post(endpoint, { revision: 1, started: true }, "PATCH")).status).toBe(200);
      expect(f.stores.deliveries.get(first.delivery.id)?.maintenance?.runUrl).toBe(
        "https://github.com/owner/hub/actions/runs/42",
      );
      expect(() => f.queue.replay(first.delivery.id)).toThrow("cannot be enqueued");
      expect(
        matchRoutes([route], {
          source: "webhook",
          kind: "local.maintenance",
          deliveryId: "foreign",
          occurredAt: "now",
          summary: "",
          payload: { provider: "remnote-maintenance" },
        }),
      ).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it("rejects oversized commands without reserving them, duplicated mappings, and rebinding", async () => {
    const f = fixture();
    try {
      const { route } = (await (await f.post("/api/routes", f.input)).json()) as { route: Route };
      const result = await f.post(`/api/routes/${route.id}/maintenance`, {
        taskRemId: "big",
        originalTitle: "%big",
        fingerprint: "a".repeat(64),
        prompt: "中文".repeat(12000),
      });
      expect(result.status).toBe(413);
      expect(f.stores.deliveries.listMaintenance(route.id)).toEqual([]);
      expect((await f.post("/api/routes", f.input)).status).toBe(409);
      expect(
        (
          await f.post("/api/routes", {
            ...f.input,
            target: { ...f.input.target, documentRemId: "other" },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await f.post(
            `/api/routes/${route.id}`,
            { ...f.input, target: { ...f.input.target, repository: "owner/other" } },
            "PUT",
          )
        ).status,
      ).toBe(409);
    } finally {
      f.db.close();
    }
  });
});
