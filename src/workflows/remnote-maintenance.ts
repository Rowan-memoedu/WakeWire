import type { MaintenanceReceipt } from "./maintenance-types.js";
import {
  allChildren,
  displayStartedTitle,
  fingerprintTaskNodes,
  isMarked,
  type RemNode,
  type RemNoteReader,
  relocateStarted,
} from "./remnote-todo.js";

export async function taskFingerprint(
  remnote: RemNoteReader,
  taskRemId: string,
  excludedRemId?: string,
): Promise<string> {
  const nodes = new Map<string, RemNode>();
  const seen = new Set<string>();
  const visit = async (node: RemNode) => {
    if (seen.has(node.remId)) throw new Error("cycle in task subtree");
    seen.add(node.remId);
    nodes.set(node.remId, node);
    for (const child of await allChildren(remnote, node.remId)) {
      if (child.remId === excludedRemId || (child.parentRemId && child.parentRemId !== node.remId))
        continue;
      await visit(child);
    }
  };
  await visit(await remnote.read(taskRemId));
  return fingerprintTaskNodes(nodes, taskRemId, excludedRemId);
}

export async function verifyDocument(
  remnote: RemNoteReader,
  documentRemId: string,
  rootRemId: string,
): Promise<void> {
  let node = await remnote.read(documentRemId);
  if (node.remType !== "document")
    throw new Error("mapping target is no longer a RemNote Document");
  const seen = new Set<string>();
  while (node.parentRemId && !seen.has(node.remId)) {
    if (node.parentRemId === rootRemId) return;
    seen.add(node.remId);
    node = await remnote.read(node.parentRemId);
  }
  throw new Error("mapped document is no longer inside To Do List");
}

export async function ensureBuckets(
  remnote: RemNoteReader,
  documentRemId: string,
): Promise<{ started: string; completed: string }> {
  const children = await allChildren(remnote, documentRemId);
  const result: Record<string, string> = {};
  for (const [key, title] of [
    ["started", "已开始"],
    ["completed", "已完成"],
  ] as const) {
    const matches = children.filter((node) => node.title === title);
    if (matches.length > 1) throw new Error(`document contains multiple ${title} nodes`);
    result[key] = matches[0]?.remId ?? (await remnote.create(documentRemId, title));
    const node = await remnote.read(result[key] as string);
    if (node.parentRemId !== documentRemId || node.title !== title)
      throw new Error("bucket readback mismatch");
  }
  return result as { started: string; completed: string };
}

export async function placeStarted(
  remnote: RemNoteReader,
  receipt: MaintenanceReceipt,
  started: string,
): Promise<void> {
  if (!receipt.runId && !(receipt.nativeThreadId && receipt.nativeTurnId))
    throw new Error("execution has not acknowledged the request");
  if (
    (await taskFingerprint(remnote, receipt.taskRemId, receipt.feedbackRemId)) !==
    receipt.fingerprint
  )
    throw new Error("task content changed after dispatch; left in place");
  const current = await remnote.read(receipt.taskRemId);
  if (
    current.parentRemId === started &&
    current.title === displayStartedTitle(receipt.originalTitle)
  )
    return;
  if (current.title !== receipt.originalTitle || !isMarked(current.title))
    throw new Error("task marker changed after dispatch; left in place");
  await relocateStarted(remnote, receipt.documentRemId, current);
}

export async function placeCompleted(
  remnote: RemNoteReader,
  receipt: MaintenanceReceipt,
  started: string,
  completed: string,
): Promise<void> {
  if (!receipt.started || (!receipt.runId && !(receipt.nativeThreadId && receipt.nativeTurnId)))
    throw new Error("unacknowledged task cannot complete");
  const node = await remnote.read(receipt.taskRemId);
  if (![started, completed].includes(node.parentRemId ?? ""))
    throw new Error("task was moved by the user; left in place");
  if (
    (await taskFingerprint(remnote, receipt.taskRemId, receipt.feedbackRemId)) !==
    receipt.fingerprint
  )
    throw new Error("PR merged, but task content changed; review the remaining work");
  if (node.parentRemId !== completed) await remnote.move(node.remId, completed, started);
  for (const position of ["before", "after"] as const) {
    const siblings = await allChildren(remnote, completed);
    const index = siblings.findIndex((sibling) => sibling.remId === node.remId);
    if (index < 0) throw new Error("completed task missing after move");
    const adjacent = siblings[index + (position === "before" ? -1 : 1)];
    if (adjacent?.title !== "" || (await allChildren(remnote, adjacent.remId)).length) {
      const id = await remnote.create(completed, "");
      await remnote.move(id, completed, completed, position, node.remId);
    }
  }
  const after = await remnote.read(node.remId);
  if (
    after.parentRemId !== completed ||
    after.title !== node.title ||
    (await taskFingerprint(remnote, node.remId, receipt.feedbackRemId)) !== receipt.fingerprint
  )
    throw new Error("completed placement readback mismatch");
}
