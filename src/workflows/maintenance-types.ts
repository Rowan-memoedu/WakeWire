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
    bindings: z
      .array(
        z.object({
          documentRemId: RemId,
          title: z.string(),
          repository: Repository,
          routeId: z.string().optional(),
        }),
      )
      .min(1),
  })
  .superRefine((config, ctx) => {
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
}

export function maintenanceRequestId(documentRemId: string, taskRemId: string): string {
  return `rn-${crypto.createHash("sha256").update(`${documentRemId}\0${taskRemId}`).digest("hex").slice(0, 48)}`;
}
