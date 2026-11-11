import crypto from "node:crypto";
import { z } from "zod";
import { ensureStartedBucket } from "./remnote-command-sources.js";
import {
  acknowledgeStarted,
  allChildren,
  fingerprintTaskNodes,
  losslessTitle,
  NUMBERED_MARKER,
  type RemNode,
  type RemNoteReader,
  type TodoReceipt,
  type TodoTask,
} from "./remnote-todo.js";

const MemberSchema = z.object({
  taskRemId: z.string().min(1),
  contextRemId: z.string().min(1),
  documentRemId: z.string().min(1),
  sourceDeliveryId: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  subtreeFingerprint: z.string(),
});
export const CommandBatchSchema = z
  .object({
    documentRemId: z.string().min(1),
    members: z.array(MemberSchema).min(1),
    renumber: z.array(
      z.object({
        remId: z.string().min(1),
        originalTitle: z.string(),
        title: z.string(),
        number: z.number().int().positive(),
      }),
    ),
    acknowledgedAt: z.string().optional(),
  })
  .superRefine((batch, ctx) => {
    if (
      batch.members.some((t) => t.documentRemId !== batch.documentRemId) ||
      new Set(batch.members.map((t) => t.taskRemId)).size !== batch.members.length
    )
      ctx.addIssue({
        code: "custom",
        message: "batch members must have distinct IDs in one Document",
      });
  });
export type CommandBatch = z.infer<typeof CommandBatchSchema>;

function sequence(title: string): number | undefined {
  const match = NUMBERED_MARKER.exec(title);
  if (!match) return undefined;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new Error("maintenance sequence is too large");
  return number;
}

/** Unnumbered items win; otherwise only the smallest sequence is eligible this scan. */
export function maintenanceBatch(tasks: TodoTask[]): TodoTask | undefined {
  if (!tasks.length) return undefined;
  const documentRemId = tasks[0]?.documentRemId as string;
  if (tasks.some((t) => t.documentRemId !== documentRemId))
    throw new Error("cannot batch different Documents");
  const unnumbered = tasks.filter((t) => sequence(t.title) === undefined);
  const first = unnumbered.length
    ? undefined
    : Math.min(...tasks.map((t) => sequence(t.title) as number));
  const members = unnumbered.length ? unnumbered : tasks.filter((t) => sequence(t.title) === first);
  const renumber =
    first === undefined
      ? []
      : tasks
          .filter((t) => (sequence(t.title) ?? 0) > first)
          .map((t) => ({
            remId: t.taskRemId,
            originalTitle: t.title,
            title: t.title.replace(
              NUMBERED_MARKER,
              (_token, prefix: string, number: string) => `${prefix}%${Number(number) - 1}`,
            ),
            number: (sequence(t.title) as number) - 1,
          }));
  const batch = CommandBatchSchema.parse({ documentRemId, members, renumber });
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([documentRemId, members.map((t) => t.taskRemId).sort()]))
    .digest("hex");
  return {
    ...(members[0] as TodoTask),
    sourceDeliveryId: `remnote-maintenance-batch:${digest}`,
    prompt: members.map((t) => t.prompt).join("\n\n"),
    commandBatch: batch,
    ...(tasks[0]?.developerInstructions
      ? { developerInstructions: tasks[0].developerInstructions }
      : {}),
  };
}

async function fingerprint(remnote: RemNoteReader, taskRemId: string): Promise<string> {
  const nodes = new Map<string, RemNode>();
  const visit = async (node: RemNode): Promise<void> => {
    if (nodes.has(node.remId)) throw new Error("cycle in batch member");
    nodes.set(node.remId, node);
    for (const child of await allChildren(remnote, node.remId))
      if (!child.parentRemId || child.parentRemId === node.remId) await visit(child);
  };
  await visit(await remnote.read(taskRemId));
  return fingerprintTaskNodes(nodes, taskRemId, undefined, true);
}

/** Idempotent recovery uses the immutable batch in the original delivery receipt. */
export async function acknowledgeBatch(
  remnote: RemNoteReader,
  batch: CommandBatch,
  receipt: TodoReceipt,
): Promise<void> {
  if (!receipt.threadId || !receipt.turnId) throw new Error("batch first turn is not accepted");
  if (batch.acknowledgedAt) return;
  for (const member of batch.members)
    if ((await fingerprint(remnote, member.taskRemId)) !== member.subtreeFingerprint)
      throw new Error("batch member changed after export; placement and numbering need review");
  await ensureStartedBucket(remnote, batch.members[0] as TodoTask);
  for (const member of batch.members)
    if ((await acknowledgeStarted(remnote, member, receipt, true)) === "changed")
      throw new Error("batch member marker or location changed; no new dispatch");
  for (const change of batch.renumber) {
    const current = await remnote.read(change.remId);
    if (current.title === change.title) continue;
    if (current.title !== change.originalTitle)
      throw new Error("later sequence changed; no renumber overwrite");
    const writeTitle = losslessTitle(current).replace(
      NUMBERED_MARKER,
      (_token, prefix: string) => `${prefix}%${change.number}`,
    );
    await remnote.updateTitle(change.remId, writeTitle);
    const after = await remnote.read(change.remId);
    if (
      after.title !== change.title ||
      after.parentRemId !== current.parentRemId ||
      JSON.stringify(after.inlineRefs ?? []) !== JSON.stringify(current.inlineRefs ?? [])
    )
      throw new Error("sequence readback mismatch");
  }
}
