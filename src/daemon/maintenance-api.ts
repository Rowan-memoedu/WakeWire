import type { Hono } from "hono";
import { z } from "zod";
import type { RouteInput } from "../core/route.js";
import type { Stores } from "../db/repos.js";
import {
  type MaintenanceReceipt,
  maintenanceRequestId,
  NativeCheckSchema,
  RemId,
} from "../workflows/maintenance-types.js";

export function maintenanceRouteConflict(
  stores: Stores,
  input: RouteInput,
  id?: string,
): string | null {
  if (input.target.type !== "github-actions") return null;
  const target = input.target;
  const old = id ? stores.routes.get(id) : null;
  if (
    old?.target.type === "github-actions" &&
    JSON.stringify(old.target) !== JSON.stringify(target)
  )
    return "existing maintenance mapping is immutable; review its receipts before rebinding";
  if (
    stores.routes
      .list()
      .some(
        (r) =>
          r.id !== id &&
          r.target.type === "github-actions" &&
          (r.target.documentRemId === target.documentRemId ||
            r.target.repository.toLowerCase() === target.repository.toLowerCase()),
      )
  )
    return "document/repository mapping already exists";
  return null;
}

/** Uses the existing authenticated localhost API and delivery ledger; GitHub owns execution. */
export function mountMaintenanceApi(app: Hono, stores: Stores): void {
  app.get("/api/deliveries/:id/maintenance", (c) => {
    const delivery = stores.deliveries.get(c.req.param("id"));
    if (!delivery?.maintenance) return c.json({ error: "maintenance receipt missing" }, 404);
    return c.json({ delivery });
  });
  app.get("/api/routes/:id/maintenance", (c) => {
    const route = stores.routes.get(c.req.param("id"));
    if (route?.target.type !== "github-actions")
      return c.json({ error: "maintenance route missing" }, 404);
    return c.json({ deliveries: stores.deliveries.listMaintenance(route.id) });
  });
  app.post("/api/routes/:id/maintenance", async (c) => {
    const route = stores.routes.get(c.req.param("id"));
    if (!route?.enabled || route.target.type !== "github-actions")
      return c.json({ error: "maintenance route disabled or missing" }, 409);
    const input = z
      .object({
        taskRemId: RemId,
        prompt: z.string().min(1),
        originalTitle: z.string().min(1),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        nativeRequested: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid maintenance request" }, 400);
    const requestId = maintenanceRequestId(route.target.documentRemId, input.data.taskRemId);
    const payload = {
      ref: route.target.ref,
      return_run_details: true,
      inputs: { project: route.target.repository, task: input.data.prompt, request_id: requestId },
    };
    if (!input.data.nativeRequested && Buffer.byteLength(JSON.stringify(payload), "utf8") > 65000)
      return c.json({ error: "command exceeds GitHub dispatch payload limit; not truncated" }, 413);
    const result = stores.deliveries.beginMaintenance(route.id, requestId, input.data.prompt, {
      revision: 0,
      documentRemId: route.target.documentRemId,
      taskRemId: input.data.taskRemId,
      requestId,
      originalTitle: input.data.originalTitle,
      fingerprint: input.data.fingerprint,
      started: false,
      completed: false,
      ...(input.data.nativeRequested
        ? { nativeRequested: true, nativeChecks: [], nativeFinalized: false }
        : {}),
    });
    return c.json(result, result.created ? 201 : 200);
  });
  app.patch("/api/deliveries/:id/maintenance", async (c) => {
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        runId: z.number().int().positive().optional(),
        feedbackRemId: RemId.optional(),
        prUrl: z.string().url().optional(),
        started: z.boolean().optional(),
        completed: z.boolean().optional(),
        lastStatus: z.string().max(2000).optional(),
        nativeRequested: z.boolean().optional(),
        nativeDeliveryId: z.string().uuid().optional(),
        nativeThreadId: z.string().min(1).optional(),
        nativeTurnId: z.string().min(1).optional(),
        nativeFinalized: z.boolean().optional(),
        nativeChecks: z.array(NativeCheckSchema).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid maintenance receipt patch" }, 400);
    const delivery = stores.deliveries.get(c.req.param("id"));
    const route = delivery ? stores.routes.get(delivery.routeId) : null;
    if (!delivery?.maintenance || route?.target.type !== "github-actions")
      return c.json({ error: "maintenance receipt missing" }, 404);
    const { revision, ...patch } = input.data;
    if (
      (patch.started || patch.completed) &&
      !(
        delivery.maintenance.runId ||
        patch.runId ||
        ((delivery.maintenance.nativeThreadId || patch.nativeThreadId) &&
          (delivery.maintenance.nativeTurnId || patch.nativeTurnId))
      )
    )
      return c.json({ error: "no acknowledged Actions run" }, 409);
    const hubOwner = route.target.hub.split("/")[0]?.toLowerCase();
    if (
      patch.nativeChecks?.some(
        (check) => check.repository.split("/")[0]?.toLowerCase() !== hubOwner,
      )
    )
      return c.json({ error: "related repository owner differs from the maintenance hub" }, 409);
    try {
      return c.json({
        delivery: stores.deliveries.updateMaintenance(delivery.id, revision, {
          ...(Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          ) as Partial<MaintenanceReceipt>),
          ...(patch.runId
            ? { runUrl: `https://github.com/${route.target.hub}/actions/runs/${patch.runId}` }
            : {}),
        }),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "receipt conflict" }, 409);
    }
  });
}
