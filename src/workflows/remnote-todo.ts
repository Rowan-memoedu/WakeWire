import crypto from "node:crypto";

export interface RemNode {
  remId: string;
  title: string;
  headline?: string | undefined;
  parentRemId?: string | undefined;
  inlineRefs?: Array<{ targetRemId: string; text: string }> | undefined;
  media?: unknown[] | undefined;
  remType?: string | undefined;
}

export interface RemPage {
  children: RemNode[];
  hasMore?: boolean | undefined;
  nextCursor?: string | undefined;
}

export interface RemNoteReader {
  children(parentRemId: string, cursor?: string): Promise<RemPage>;
  read(remId: string): Promise<RemNode>;
  updateTitle(remId: string, title: string): Promise<void>;
  create(parentRemId: string, title: string): Promise<string>;
  move(
    remId: string,
    parentRemId: string,
    oldParentRemId: string,
    position?: "last" | "before" | "after",
    siblingRemId?: string,
  ): Promise<void>;
}

export interface TodoTask {
  taskRemId: string;
  contextRemId: string;
  documentRemId: string;
  sourceDeliveryId: string;
  title: string;
  prompt: string;
  subtreeFingerprint?: string;
}

export interface TodoReceipt {
  id: string;
  status: string;
  threadId: string | null;
  turnId: string | null;
  dispatchStarted: boolean;
}

export interface TodoDispatcher {
  receipt(sourceDeliveryId: string): Promise<TodoReceipt | null>;
  enqueue(task: TodoTask): Promise<void>;
}

const MARKER = /^(\s*(?:\*\*|__|~~|\*|_)*)%(?!%)(?=\s*\S)/u;
const MAINTENANCE = /^(\s*(?:\*\*|__|~~|\*|_)*)%%/u;

export function isMarked(title: string): boolean {
  return MARKER.test(title);
}

export function displayStartedTitle(title: string): string {
  return title.replace(MARKER, "$1");
}

const LEGACY_STARTED = /^(\s*(?:\*\*|__|~~|\*|_)*)已开始[：:]/u;

function isTaskRoot(nodes: Map<string, RemNode>, node: RemNode, documentRemId: string): boolean {
  const parent = nodes.get(node.parentRemId ?? "");
  return (
    node.parentRemId === documentRemId ||
    (parent?.parentRemId === documentRemId && parent.title === "已开始")
  );
}

export async function allChildren(remnote: RemNoteReader, parent: string): Promise<RemNode[]> {
  const result: RemNode[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await remnote.children(parent, cursor);
    result.push(...page.children);
    if (!page.hasMore) break;
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new Error("incomplete placement pagination");
    cursor = page.nextCursor;
    cursors.add(cursor);
  } while (cursor);
  return result;
}

/** Move the original subtree, then clear its marker only after placement has been verified. */
export async function relocateStarted(
  remnote: RemNoteReader,
  documentRemId: string,
  node: RemNode,
): Promise<void> {
  const buckets = (await allChildren(remnote, documentRemId)).filter((n) => n.title === "已开始");
  if (buckets.length !== 1) throw new Error("expected one existing 已开始 node in the document");
  const bucket = buckets[0] as RemNode;
  const expected = node.title.replace(MARKER, "$1").replace(LEGACY_STARTED, "$1");
  // Validate lossless title conversion before moving anything.
  const writeTitle = startedTitle(node);
  if (!node.parentRemId) throw new Error("task parent is missing");
  if (node.parentRemId !== bucket.remId) {
    const siblings = await allChildren(remnote, bucket.remId);
    const last = siblings.at(-1);
    const trailingBlank =
      last?.title === "" && (await allChildren(remnote, last.remId)).length === 0;
    await remnote.move(
      node.remId,
      bucket.remId,
      node.parentRemId,
      trailingBlank ? "before" : "last",
      trailingBlank ? last.remId : undefined,
    );
  }
  for (const position of ["before", "after"] as const) {
    const siblings = await allChildren(remnote, bucket.remId);
    const index = siblings.findIndex((n) => n.remId === node.remId);
    if (index < 0) throw new Error("moved task is missing from 已开始");
    const adjacent = siblings[index + (position === "before" ? -1 : 1)];
    const blank =
      adjacent &&
      adjacent.title === "" &&
      (await allChildren(remnote, adjacent.remId)).length === 0;
    if (!blank) {
      const id = await remnote.create(bucket.remId, "");
      await remnote.move(id, bucket.remId, bucket.remId, position, node.remId);
    }
  }
  const placed = await remnote.read(node.remId);
  if (placed.parentRemId !== bucket.remId || placed.title !== node.title) {
    throw new Error("task changed during placement; marker retained");
  }
  await remnote.updateTitle(node.remId, writeTitle);
  const readback = await remnote.read(node.remId);
  if (readback.parentRemId !== bucket.remId || readback.title !== expected) {
    throw new Error("started placement readback mismatch");
  }
  if (JSON.stringify(readback.inlineRefs ?? []) !== JSON.stringify(node.inlineRefs ?? [])) {
    throw new Error("reference readback mismatch after placement");
  }
}

export function eventIdFor(documentRemId: string, taskRemId: string): string {
  const digest = crypto.createHash("sha256").update(`${documentRemId}\0${taskRemId}`).digest("hex");
  return `remnote-todo:${digest}`;
}

/** Visit all real descendants, with cursor validation; never follow portals outside the tree. */
export async function scanTodo(
  remnote: RemNoteReader,
  documentRemId: string,
  progress: (count: number) => void = () => {},
  excludedRemIds: ReadonlySet<string> = new Set(),
): Promise<{ tasks: TodoTask[]; conflicts: string[]; nodeCount: number }> {
  const nodes = new Map<string, RemNode>();
  const pending = [documentRemId];
  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index] as string;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await remnote.children(parent, cursor);
      for (const child of page.children) {
        if (excludedRemIds.has(child.remId)) continue;
        if (child.parentRemId && child.parentRemId !== parent) continue;
        if (nodes.has(child.remId) || child.remId === documentRemId) continue;
        nodes.set(child.remId, { ...child, parentRemId: parent });
        pending.push(child.remId);
      }
      if (!page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) {
        throw new Error(`incomplete RemNote pagination under ${parent}`);
      }
      cursor = page.nextCursor;
      cursors.add(cursor);
    } while (cursor !== undefined);
    if (index % 25 === 0) progress(nodes.size);
  }

  const marked = [...nodes.values()].filter((node) => {
    if (!isMarked(node.title)) return false;
    let parent = node.parentRemId;
    while (parent && parent !== documentRemId) {
      const ancestor = nodes.get(parent);
      if (ancestor && MAINTENANCE.test(ancestor.title)) return false;
      parent = ancestor?.parentRemId;
    }
    return true;
  });
  const markedIds = new Set(marked.map((node) => node.remId));
  const conflicts = new Set<string>();
  for (const node of marked) {
    let parent = node.parentRemId;
    while (parent && parent !== documentRemId) {
      if (markedIds.has(parent)) {
        conflicts.add(parent);
        conflicts.add(node.remId);
      }
      parent = nodes.get(parent)?.parentRemId;
    }
  }
  const tasks = marked
    .filter((node) => !conflicts.has(node.remId))
    .map((node) => ({
      taskRemId: node.remId,
      contextRemId: isTaskRoot(nodes, node, documentRemId)
        ? node.remId
        : (node.parentRemId as string),
      documentRemId,
      sourceDeliveryId: eventIdFor(documentRemId, node.remId),
      title: node.title,
      prompt: renderTaskPrompt(nodes, node.remId, documentRemId),
      subtreeFingerprint: fingerprintTaskNodes(nodes, node.remId),
    }));
  return { tasks, conflicts: [...conflicts], nodeCount: nodes.size };
}

/** Freeze the same source snapshot as the rendered command, including ordered descendant IDs. */
export function fingerprintTaskNodes(
  nodes: Map<string, RemNode>,
  taskRemId: string,
  excludedRemId?: string,
): string {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) throw new Error("cycle in task subtree");
    seen.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error("task snapshot is incomplete");
    const headline = node.headline ?? node.title;
    rows.push([
      id,
      id === taskRemId ? displayStartedTitle(node.title) : node.title,
      id === taskRemId ? displayStartedTitle(headline) : headline,
      node.inlineRefs ?? [],
    ]);
    for (const child of nodes.values())
      if (child.parentRemId === id && child.remId !== excludedRemId) visit(child.remId);
  };
  visit(taskRemId);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** Keep Markdown formatting and resolve reference tokens by exact ID, never by title search. */
export function startedTitle(node: RemNode): string {
  if (!isMarked(node.title) && !LEGACY_STARTED.test(node.title))
    throw new Error("dispatch marker is no longer present");
  if (node.media?.length || /!\[|<img\b/i.test(node.title)) {
    throw new Error("title contains media; prefix update needs a lossless RichText operation");
  }
  const references = new Map<string, Set<string>>();
  for (const ref of node.inlineRefs ?? []) {
    const ids = references.get(ref.text) ?? new Set<string>();
    ids.add(ref.targetRemId);
    references.set(ref.text, ids);
  }
  const title = node.title.replace(/\[\[([^\]]+)\]\]/g, (_token, label: string) => {
    if (/^id:[A-Za-z0-9_-]+$/.test(label)) return `[[${label}]]`;
    const ids = references.get(label);
    if (ids?.size !== 1) throw new Error("ambiguous inline reference; title left unchanged");
    return `[[id:${[...ids][0]}]]`;
  });
  return displayStartedTitle(title).replace(LEGACY_STARTED, "$1");
}

/** Only a thread AND accepted first turn authorize the visible started marker. */
export async function acknowledgeStarted(
  remnote: RemNoteReader,
  task: TodoTask,
  receipt: TodoReceipt,
): Promise<"marked" | "already-marked" | "changed"> {
  if (!receipt.threadId || !receipt.turnId) throw new Error("first turn has not been acknowledged");
  const current = await remnote.read(task.taskRemId);
  const expected = displayStartedTitle(task.title);
  if (current.title === expected) {
    const buckets = (await allChildren(remnote, task.documentRemId)).filter(
      (n) => n.title === "已开始",
    );
    return buckets.length === 1 && current.parentRemId === buckets[0]?.remId
      ? "already-marked"
      : "changed";
  }
  if (current.title !== task.title || !isMarked(current.title)) return "changed";
  await relocateStarted(remnote, task.documentRemId, current);
  return "marked";
}

/** Existing receipts, including unknown outcomes and failures, always suppress another creation. */
export async function ensureQueued(dispatcher: TodoDispatcher, task: TodoTask): Promise<void> {
  if (await dispatcher.receipt(task.sourceDeliveryId)) return;
  await dispatcher.enqueue(task);
}

/** Export the visible original outline. Routing IDs and operational instructions stay local. */
export function renderTaskPrompt(
  nodes: Map<string, RemNode>,
  taskRemId: string,
  documentRemId: string,
): string {
  const task = nodes.get(taskRemId);
  if (!task) throw new Error("task is missing from the completed source scan");
  const topLevel = isTaskRoot(nodes, task, documentRemId);
  const context = topLevel ? task : nodes.get(task.parentRemId ?? "");
  if (!context) throw new Error("task parent is missing from the completed source scan");
  const children = new Map<string, RemNode[]>();
  for (const node of nodes.values()) {
    if (!node.parentRemId) continue;
    const siblings = children.get(node.parentRemId) ?? [];
    siblings.push(node);
    children.set(node.parentRemId, siblings);
  }
  const visibleText = (node: RemNode): string => {
    let value = node.headline ?? node.title;
    if (node.remId === taskRemId) value = value.replace(MARKER, "$1");
    for (const ref of node.inlineRefs ?? []) {
      value = value
        .replaceAll(`[[${ref.text}]]`, ref.text)
        .replaceAll(`[[id:${ref.targetRemId}]]`, ref.text);
    }
    return value;
  };
  const hasContent = (node: RemNode): boolean =>
    visibleText(node).trim().length > 0 || (children.get(node.remId) ?? []).some(hasContent);
  const displayedChildren = (node: RemNode): RemNode[] =>
    (children.get(node.remId) ?? []).filter(hasContent);
  const lines: string[] = [];
  const visit = (node: RemNode, depth: number): void => {
    const indent = "  ".repeat(depth);
    const [first = "", ...rest] = visibleText(node).split("\n");
    lines.push(`${indent}- ${first}`, ...rest.map((line) => `${indent}  ${line}`));
    for (const child of displayedChildren(node)) visit(child, depth + 1);
  };
  visit(context, 0);
  const original = lines.join("\n");
  if (topLevel) return original;
  const index = displayedChildren(context).findIndex((node) => node.remId === taskRemId);
  if (index < 0) throw new Error("task is missing from its parent's visible children");
  return `本次任务是下文母项的第 ${index + 1} 个子项及其下属内容，其他部分仅作背景。\n\n${original}`;
}
