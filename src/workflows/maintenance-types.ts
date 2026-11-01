import crypto from "node:crypto";
import { z } from "zod";

export const RemId = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const Repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
export const MaintenanceConfigSchema = z
  .object({
    hub: Repository,
    mcpUrl: z.string().url(),
    wakewireHome: z.string().min(1),
    legacyDocumentRemId: RemId,
    legacyRouteId: z.string().min(1),
    resultRoot: z.string().min(1),
    execution: z.enum(["actions", "native"]).default("actions"),
    native: z
      .object({
        cwd: z.string().min(1),
        appProjectId: z.string().min(1),
        appOwnerThreadId: z.string().min(1),
        routeId: z.string().optional(),
      })
      .optional(),
    bindings: z
      .array(
        z.object({
          documentRemId: RemId,
          title: z.string(),
          repository: Repository,
          localPath: z.string().optional(),
          routeId: z.string().optional(),
        }),
      )
      .min(1),
  })
  .superRefine((config, ctx) => {
    if (
      config.execution === "native" &&
      (!config.native || config.bindings.some((b) => !b.localPath))
    )
      ctx.addIssue({
        code: "custom",
        message: "native maintenance needs its saved local project and repository paths",
      });
    const docs = new Set<string>();
    const repos = new Set<string>();
    for (const b of config.bindings) {
      if (docs.has(b.documentRemId) || repos.has(b.repository.toLowerCase()))
        ctx.addIssue({
          code: "custom",
          message: "document/repository mappings must be one-to-one",
        });
      if (b.repository.split("/")[0]?.toLowerCase() !== config.hub.split("/")[0]?.toLowerCase())
        ctx.addIssue({ code: "custom", message: "repository owner differs from maintenance hub" });
      docs.add(b.documentRemId);
      repos.add(b.repository.toLowerCase());
    }
  });
export type MaintenanceConfig = z.infer<typeof MaintenanceConfigSchema>;
export type MaintenanceBinding = MaintenanceConfig["bindings"][number];

export const NativeCheckSchema = z.object({
  id: z.string().uuid(),
  repository: Repository,
  branch: z.string().min(1),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.number().int().positive().optional(),
  runUrl: z.string().url().optional(),
});
export type NativeCheck = z.infer<typeof NativeCheckSchema>;

export function latestNativeChecks(checks: NativeCheck[]): NativeCheck[] {
  return [...new Map(checks.map((check) => [check.repository.toLowerCase(), check])).values()];
}

export interface MaintenanceReceipt {
  revision: number;
  documentRemId: string;
  taskRemId: string;
  requestId: string;
  originalTitle: string;
  fingerprint: string;
  runId?: number;
  runUrl?: string;
  feedbackRemId?: string;
  prUrl?: string;
  started: boolean;
  completed: boolean;
  lastStatus?: string;
  nativeRequested?: boolean;
  nativeDeliveryId?: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeFinalized?: boolean;
  nativeChecks?: NativeCheck[];
}

export function maintenanceRequestId(documentRemId: string, taskRemId: string): string {
  return `rn-${crypto.createHash("sha256").update(`${documentRemId}\0${taskRemId}`).digest("hex").slice(0, 48)}`;
}
