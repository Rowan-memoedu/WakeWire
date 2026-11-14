import crypto from "node:crypto";
import {
  allChildren,
  displayStartedTitle,
  isMarked,
  losslessTitle,
  type RemNode,
  type RemNoteReader,
} from "./remnote-todo.js";

export interface ArticleNode extends RemNode {
  depth: number;
  text: string;
}
export interface ArticleSource {
  remId: string;
  parentRemId: string;
  fingerprint: string;
  nodes: ArticleNode[];
}
export interface ArticleReceipt {
  source: ArticleSource;
  slot: string;
  title: string;
  html: string;
  text: string;
  format: string;
  stage: "submitting" | "published" | "verified" | "archived";
  articleId?: string;
  columnId: string;
  url?: string;
}
export interface ArticleState {
  receipts: ArticleReceipt[];
  drafts?: ArticleDraft[];
}
export interface CloudDraft {
  id: string;
  authorId: string;
  title: string;
  text: string;
  format: string;
  state: string;
  editorUrl: string;
}
export interface ArticleDraft {
  source: ArticleSource;
  title: string;
  html: string;
  text: string;
  format: string;
  status: "creating" | "review" | "ready" | "published";
  draftId?: string;
  editorUrl?: string;
  cloudBefore?: Pick<CloudDraft, "title" | "text" | "format">;
}

export async function saveReviewDraft(options: {
  remnote: RemNoteReader;
  publisher: ArticlePublisher;
  documentRemId: string;
  accountId: string;
  columnId: string;
  seriesStartDate: string;
  state: ArticleState;
  save: () => void;
  now: Date;
  sourceRemId?: string;
}): Promise<{
  status: string;
  id: string;
  title: string;
  editorUrl: string;
  published: number;
  moved: number;
}> {
  const { publisher, remnote, state, save } = options;
  if (
    !publisher.seriesStats ||
    !publisher.createDraft ||
    !publisher.readDraft ||
    !publisher.writeDraft
  )
    throw new Error("cloud draft capabilities are unavailable");
  const scan = await scanArticles(remnote, options.documentRemId);
  const source = scan.sources.find(
    (candidate) =>
      !state.receipts.some((receipt) => receipt.source.remId === candidate.remId) &&
      (!options.sourceRemId || candidate.remId === options.sourceRemId),
  );
  if (!source) throw new Error("no eligible marked source for draft preview");
  const prepared = await publisher.prepare(source.nodes);
  prepared.title = seriesTitle(
    prepared.title,
    options.now,
    options.seriesStartDate,
    await publisher.seriesStats(),
    state,
  );
  const account = await publisher.check();
  if (account.id !== options.accountId || account.columnId !== options.columnId)
    throw new Error("draft account or column changed");
  state.drafts ??= [];
  let draft = state.drafts.find((item) => item.source.remId === source.remId);
  let cloud: CloudDraft | undefined;
  if (draft) {
    if (!draft.draftId)
      throw new Error("unknown draft creation result; automatic recreation blocked");
    cloud = await publisher.readDraft(draft.draftId);
    const matches = (expected: Pick<CloudDraft, "title" | "text" | "format">) =>
      cloud?.title === expected.title &&
      cloud.text === expected.text &&
      cloud.format === expected.format;
    if (
      cloud.authorId !== options.accountId ||
      cloud.state !== "draft" ||
      (!matches(draft) &&
        !(
          draft.status === "creating" &&
          ((!cloud.title && !cloud.text) || (draft.cloudBefore && matches(draft.cloudBefore)))
        ))
    )
      throw new Error("cloud draft changed; author edits were preserved");
    Object.assign(draft, prepared, { source, status: "creating", cloudBefore: cloud });
  } else {
    draft = { source, ...prepared, status: "creating" };
    state.drafts.push(draft);
  }
  save(); // Fence draft creation so another invocation cannot create a duplicate.
  if (!draft.draftId) {
    const created = await publisher.createDraft();
    if (!/^\d+$/u.test(created.id)) throw new Error("new draft ID missing");
    draft.draftId = created.id;
    save(); // Persist the ID before writing or reading the newly created draft.
    cloud = await publisher.readDraft(created.id);
    if (
      cloud.title ||
      cloud.text ||
      cloud.authorId !== options.accountId ||
      cloud.state !== "draft"
    )
      throw new Error("new cloud draft is not empty and owned by the configured account");
  }
  draft.cloudBefore = cloud as CloudDraft;
  save();
  const saved = await publisher.writeDraft(
    draft.draftId,
    prepared.title,
    prepared.html,
    cloud as CloudDraft,
  );
  if (
    saved.id !== draft.draftId ||
    saved.authorId !== options.accountId ||
    saved.state !== "draft" ||
    saved.title !== prepared.title ||
    saved.text !== prepared.text ||
    saved.format !== prepared.format
  )
    throw new Error("saved cloud draft readback mismatch");
  draft.editorUrl = saved.editorUrl;
  draft.status = "review";
  delete draft.cloudBefore;
  save();
  return {
    status: "draft-review",
    id: saved.id,
    title: saved.title,
    editorUrl: saved.editorUrl,
    published: 0,
    moved: 0,
  };
}
export interface SeriesStats {
  publishedCount: number;
  maxOrdinal: number;
}
export interface ArticlePublisher {
  prepare(
    nodes: ArticleNode[],
  ): Promise<{ title: string; html: string; text: string; format: string }>;
  check(): Promise<{ id: string; name: string; urlToken: string; columnId: string }>;
  publish(title: string, html: string, draft?: ArticleDraft): Promise<{ id: string }>;
  seriesStats?(): Promise<SeriesStats>;
  createDraft?(): Promise<{ id: string }>;
  readDraft?(id: string): Promise<CloudDraft>;
  writeDraft?(id: string, title: string, html: string, expected: CloudDraft): Promise<CloudDraft>;
  verify(id: string): Promise<{
    id: string;
    authorId: string;
    title: string;
    text: string;
    format: string;
    columnIds: string[];
    url: string;
  }>;
}

const SERIES_SUFFIX = /（第(\d+)\s*篇\s*\|\s*day\s*\d+）$/u;
export function seriesTitle(
  base: string,
  now: Date,
  startDate: string,
  stats: SeriesStats,
  state: ArticleState,
): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(startDate) ||
    !Number.isFinite(start) ||
    new Date(start).toISOString().slice(0, 10) !== startDate
  )
    throw new Error("invalid series start date");
  const day = (Date.parse(`${date}T00:00:00Z`) - start) / 86400000 + 1;
  if (!Number.isInteger(day) || day < 1) throw new Error("series date precedes first publication");
  const local = state.receipts.map((receipt) =>
    Number(SERIES_SUFFIX.exec(receipt.title)?.[1] ?? 0),
  );
  const ordinal = Math.max(stats.publishedCount, stats.maxOrdinal, ...local, 0) + 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("invalid series ordinal");
  const title = `${base.replace(SERIES_SUFFIX, "")}（第${ordinal} 篇 | day ${day}）`;
  if ([...title].length > 100)
    throw new Error("article title including series suffix exceeds 100 characters");
  return title;
}

function visible(node: RemNode, root: boolean): string {
  let value = root
    ? displayStartedTitle(node.headline ?? node.title)
    : (node.headline ?? node.title);
  for (const ref of node.inlineRefs ?? []) {
    value = value
      .replaceAll(`[[${ref.text}]]`, ref.text)
      .replaceAll(`[[id:${ref.targetRemId}]]`, ref.text);
  }
  if (/\[\[[^\]]+\]\]/u.test(value)) throw new Error("unresolved Rem reference");
  return value;
}

function fingerprint(nodes: ArticleNode[]): string {
  // Placement of the root changes during archive; content and all descendant identities do not.
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        nodes.map((n, index) => [
          n.remId,
          index === 0 ? displayStartedTitle(n.title) : n.title,
          n.text,
          n.depth,
          n.inlineRefs ?? [],
          n.media ?? [],
        ]),
      ),
    )
    .digest("hex");
}

export async function snapshotArticle(
  remnote: RemNoteReader,
  remId: string,
): Promise<ArticleSource> {
  const nodes: ArticleNode[] = [];
  const seen = new Set<string>();
  const visit = async (id: string, depth: number, parent?: string): Promise<void> => {
    if (seen.has(id)) throw new Error("cycle or duplicate in article subtree");
    if (depth > 80 || seen.size > 5000) throw new Error("article subtree exceeds safety bounds");
    seen.add(id);
    const node = await remnote.read(id);
    if (parent && node.parentRemId !== parent) throw new Error("article subtree moved during scan");
    if (node.remType === "portal" || node.media?.length || /!\[|<img\b|<video\b/iu.test(node.title))
      throw new Error("article contains media or portal; manual handling required");
    if (depth && (isMarked(node.title) || /^\s*%%/u.test(node.title)))
      throw new Error("overlapping markers in article subtree");
    nodes.push({ ...node, depth, text: visible(node, depth === 0) });
    for (const child of await allChildren(remnote, id)) {
      if (child.parentRemId !== id) throw new Error("nonphysical child in article subtree");
      await visit(child.remId, depth + 1, id);
    }
  };
  await visit(remId, 0);
  const root = nodes[0];
  if (!root?.parentRemId) throw new Error("article root parent is missing");
  return { remId, parentRemId: root.parentRemId, fingerprint: fingerprint(nodes), nodes };
}

export async function scanArticles(
  remnote: RemNoteReader,
  documentRemId: string,
): Promise<{
  sources: ArticleSource[];
  blocked: string[];
  nodeCount: number;
}> {
  const document = await remnote.read(documentRemId);
  if (document.remType !== "document") throw new Error("configured source is no longer a Document");
  const sources: ArticleSource[] = [];
  const blocked: string[] = [];
  const seen = new Set<string>();
  const visit = async (parent: string): Promise<void> => {
    for (const child of await allChildren(remnote, parent)) {
      if (seen.has(child.remId) || child.parentRemId !== parent)
        throw new Error("source scan contains duplicate or nonphysical children");
      seen.add(child.remId);
      if (seen.size > 20000) throw new Error("source exceeds safety bounds");
      if (
        (parent === documentRemId && child.title.trim() === "已发布") ||
        /^\s*%%/u.test(child.title)
      )
        continue;
      if (child.remType === "portal") {
        blocked.push(child.remId);
        continue;
      }
      if (isMarked(child.title)) {
        try {
          sources.push(await snapshotArticle(remnote, child.remId));
        } catch {
          blocked.push(child.remId);
        }
        // A marked subtree is one unit, never fall through and publish a nested child.
      } else await visit(child.remId);
    }
  };
  await visit(documentRemId);
  return { sources, blocked, nodeCount: seen.size };
}

/** Exact local date/window; late wakeups cannot burst-post missed windows. */
export function publicationSlot(now: Date): string | undefined {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  if (
    !["11", "17", "22"].includes(parts.hour ?? "") ||
    Number(parts.minute) < 30 ||
    Number(parts.minute) >= 45
  )
    return undefined;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:30+08:00`;
}

export async function archiveArticle(
  remnote: RemNoteReader,
  documentRemId: string,
  receipt: ArticleReceipt,
): Promise<void> {
  if (receipt.stage !== "verified") throw new Error("publication has not been verified");
  const source = receipt.source;
  const current = await snapshotArticle(remnote, source.remId);
  if (current.fingerprint !== source.fingerprint)
    throw new Error("source changed after publication; archive paused");
  const root = current.nodes[0] as ArticleNode;
  const original = source.nodes[0] as ArticleNode;
  const cleared = displayStartedTitle(original.title);
  if (root.title !== original.title && root.title !== cleared)
    throw new Error("source marker changed");
  const buckets = (await allChildren(remnote, documentRemId)).filter((n) => n.title === "已发布");
  if (buckets.length > 1) throw new Error("multiple 已发布 nodes");
  let bucketId = buckets[0]?.remId;
  if (!bucketId) {
    bucketId = await remnote.create(documentRemId, "已发布");
    const bucket = await remnote.read(bucketId);
    if (bucket.title !== "已发布" || bucket.parentRemId !== documentRemId)
      throw new Error("archive bucket readback mismatch");
  }
  if (root.parentRemId !== source.parentRemId && root.parentRemId !== bucketId)
    throw new Error("source moved after publication; archive paused");
  // Ensure a lossless marker update is possible before moving the original node.
  const title = displayStartedTitle(losslessTitle(original));
  if (root.parentRemId !== bucketId) await remnote.move(source.remId, bucketId, source.parentRemId);
  const placed = await snapshotArticle(remnote, source.remId);
  if (placed.parentRemId !== bucketId || placed.fingerprint !== source.fingerprint)
    throw new Error("archive placement readback mismatch");
  if (placed.nodes[0]?.title === original.title) await remnote.updateTitle(source.remId, title);
  const readback = await snapshotArticle(remnote, source.remId);
  if (
    readback.parentRemId !== bucketId ||
    readback.nodes[0]?.title !== cleared ||
    readback.fingerprint !== source.fingerprint
  )
    throw new Error("archive final readback mismatch");
}

export async function runArticles(options: {
  remnote: RemNoteReader;
  publisher: ArticlePublisher;
  documentRemId: string;
  accountId: string;
  columnId: string;
  state: ArticleState;
  save: () => void;
  now: Date;
  currentTime?: () => Date;
  seriesStartDate?: string;
}): Promise<{ status: string; published: number; archived: number; blocked: number }> {
  const { remnote, publisher, documentRemId, accountId, state, save } = options;
  // Verify source identity even if this is an archive-only recovery run.
  const document = await remnote.read(documentRemId);
  if (document.remType !== "document") throw new Error("source Document changed");
  let archived = 0;
  for (const receipt of state.receipts) {
    if (receipt.stage === "archived") continue;
    if (receipt.stage === "submitting" && !receipt.articleId)
      throw new Error("unknown publication result; automatic replay blocked");
    if (receipt.stage === "published" || receipt.stage === "submitting") {
      const result = await publisher.verify(receipt.articleId as string);
      if (
        result.id !== receipt.articleId ||
        result.authorId !== accountId ||
        result.title !== receipt.title ||
        result.text !== receipt.text ||
        result.format !== receipt.format ||
        !result.columnIds.includes(receipt.columnId) ||
        result.url !== `https://zhuanlan.zhihu.com/p/${receipt.articleId}`
      )
        throw new Error("published article readback mismatch");
      receipt.url = result.url;
      receipt.stage = "verified";
      save();
    }
    await archiveArticle(remnote, documentRemId, receipt);
    receipt.stage = "archived";
    save();
    archived++;
  }
  for (const draft of state.drafts ?? []) {
    if (!draft.draftId || draft.status === "published" || !publisher.readDraft) continue;
    const cloud = await publisher.readDraft(draft.draftId);
    if (cloud.state === "published") {
      const adopted = await adoptPublishedArticle({
        ...options,
        sourceRemId: draft.source.remId,
        articleId: draft.draftId,
      });
      draft.status = "published";
      save();
      archived += adopted.archived;
    }
  }
  const slot = publicationSlot(options.now);
  if (!slot) return { status: "outside-window", published: 0, archived, blocked: 0 };
  if (state.receipts.some((r) => r.slot === slot))
    return { status: "slot-consumed", published: 0, archived, blocked: 0 };
  const scan = await scanArticles(remnote, documentRemId);
  const completed = new Set(state.receipts.map((r) => r.source.remId));
  const held = new Set(
    (state.drafts ?? [])
      .filter((draft) => ["creating", "review"].includes(draft.status))
      .map((draft) => draft.source.remId),
  );
  const source = scan.sources.find((s) => !completed.has(s.remId) && !held.has(s.remId));
  if (!source)
    return {
      status: scan.blocked.length ? "blocked" : held.size ? "draft-review" : "empty",
      published: 0,
      archived,
      blocked: scan.blocked.length,
    };
  losslessTitle(source.nodes[0] as ArticleNode);
  const prepared = await publisher.prepare(source.nodes);
  const savedDraft = state.drafts?.find(
    (draft) => draft.source.remId === source.remId && draft.status === "ready",
  );
  if (savedDraft) {
    if (
      !savedDraft.draftId ||
      !publisher.readDraft ||
      savedDraft.source.fingerprint !== source.fingerprint
    )
      throw new Error("saved draft source changed");
    const cloud = await publisher.readDraft(savedDraft.draftId);
    if (
      cloud.state !== "draft" ||
      cloud.authorId !== accountId ||
      cloud.title !== savedDraft.title ||
      cloud.text !== savedDraft.text ||
      cloud.format !== savedDraft.format
    )
      throw new Error("cloud draft changed; preserve author edits before publication");
  }
  if (!prepared.title.trim() || [...prepared.title].length > 100 || /[\r\n]/u.test(prepared.title))
    throw new Error("article title must be one line within 100 characters");
  if (prepared.text.length < 9 || [...prepared.text].length > 100000)
    throw new Error("article body must contain 9 to 100000 characters");
  if (
    state.receipts.some(
      (r) =>
        r.title.replace(SERIES_SUFFIX, "") === prepared.title.replace(SERIES_SUFFIX, "") &&
        r.text === prepared.text,
    )
  )
    throw new Error("duplicate article content; automatic publication blocked");
  const account = await publisher.check();
  if (account.id !== accountId) throw new Error("publishing account changed");
  if (account.columnId !== options.columnId) throw new Error("publishing column changed");
  const fresh = await snapshotArticle(remnote, source.remId);
  if (
    fresh.fingerprint !== source.fingerprint ||
    fresh.parentRemId !== source.parentRemId ||
    !isMarked(fresh.nodes[0]?.title ?? "")
  )
    throw new Error("source changed before publication");
  if (publicationSlot(options.currentTime?.() ?? options.now) !== slot)
    return { status: "window-ended", published: 0, archived, blocked: scan.blocked.length };
  if (options.seriesStartDate) {
    if (!publisher.seriesStats) throw new Error("series listing is unavailable");
    prepared.title = seriesTitle(
      prepared.title,
      options.currentTime?.() ?? options.now,
      options.seriesStartDate,
      await publisher.seriesStats(),
      state,
    );
    if (publicationSlot(options.currentTime?.() ?? options.now) !== slot)
      return { status: "window-ended", published: 0, archived, blocked: scan.blocked.length };
  }
  const receipt: ArticleReceipt = {
    source,
    slot,
    ...prepared,
    columnId: options.columnId,
    stage: "submitting",
    ...(savedDraft?.draftId ? { articleId: savedDraft.draftId } : {}),
  };
  state.receipts.push(receipt);
  save(); // Durable fence BEFORE any mutation; timeout/crash cannot cause another POST.
  let deliveryDraft = savedDraft;
  if (!deliveryDraft && publisher.createDraft && publisher.readDraft) {
    const created = await publisher.createDraft();
    if (!/^\d+$/u.test(created.id)) throw new Error("created publication draft ID missing");
    receipt.articleId = created.id;
    save(); // Persist the cloud identity before any body write or publication.
    const cloud = await publisher.readDraft(created.id);
    if (
      cloud.id !== created.id ||
      cloud.authorId !== accountId ||
      cloud.state !== "draft" ||
      cloud.title ||
      cloud.text
    )
      throw new Error("new publication draft identity or content changed");
    deliveryDraft = {
      source,
      ...prepared,
      status: "ready",
      draftId: created.id,
      cloudBefore: cloud,
    };
  }
  const result = await publisher.publish(prepared.title, prepared.html, deliveryDraft);
  if (!/^\d+$/u.test(result.id))
    throw new Error("publication ID missing; automatic replay blocked");
  if (receipt.articleId && result.id !== receipt.articleId)
    throw new Error("publication draft identity changed; automatic replay blocked");
  receipt.articleId = result.id;
  receipt.stage = "published";
  save();
  const verified = await publisher.verify(result.id);
  if (
    verified.id !== result.id ||
    verified.authorId !== accountId ||
    verified.title !== prepared.title ||
    verified.text !== prepared.text ||
    verified.format !== prepared.format ||
    !verified.columnIds.includes(receipt.columnId) ||
    verified.url !== `https://zhuanlan.zhihu.com/p/${result.id}`
  )
    throw new Error("published article readback mismatch");
  receipt.url = verified.url;
  receipt.stage = "verified";
  save();
  await archiveArticle(remnote, documentRemId, receipt);
  receipt.stage = "archived";
  if (savedDraft) savedDraft.status = "published";
  save();
  return {
    status: "published",
    published: 1,
    archived: archived + 1,
    blocked: scan.blocked.length,
  };
}

/** Register an explicitly identified manual publication without creating/editing a Zhihu article. */
export async function adoptPublishedArticle(options: {
  remnote: RemNoteReader;
  publisher: ArticlePublisher;
  documentRemId: string;
  accountId: string;
  columnId: string;
  sourceRemId: string;
  articleId: string;
  state: ArticleState;
  save: () => void;
}): Promise<{ status: string; published: number; archived: number; url: string }> {
  const { remnote, publisher, state, sourceRemId, articleId } = options;
  if (!/^\d+$/u.test(articleId)) throw new Error("invalid published article ID");
  const existing = state.receipts.find(
    (receipt) => receipt.source.remId === sourceRemId || receipt.articleId === articleId,
  );
  if (
    existing?.stage === "archived" &&
    existing.articleId === articleId &&
    existing.source.remId === sourceRemId
  )
    return { status: "already-adopted", published: 0, archived: 0, url: existing.url as string };
  if (existing)
    throw new Error("source or article already has a receipt; inspect it before adoption");
  const scan = await scanArticles(remnote, options.documentRemId);
  const source = scan.sources.find((candidate) => candidate.remId === sourceRemId);
  if (!source)
    throw new Error("manual source is not a pending marked subtree in the bound Document");
  const prepared = await publisher.prepare(source.nodes);
  const published = await publisher.verify(articleId);
  if (
    published.id !== articleId ||
    published.authorId !== options.accountId ||
    published.text !== prepared.text ||
    published.format !== prepared.format ||
    !published.columnIds.includes(options.columnId) ||
    published.url !== `https://zhuanlan.zhihu.com/p/${articleId}`
  )
    throw new Error(
      "manual publication does not match the complete source, layout, author and column",
    );
  const fresh = await snapshotArticle(remnote, sourceRemId);
  if (fresh.fingerprint !== source.fingerprint || fresh.parentRemId !== source.parentRemId)
    throw new Error("source changed during manual publication readback");
  losslessTitle(source.nodes[0] as ArticleNode);
  const receipt: ArticleReceipt = {
    source,
    slot: `manual:${articleId}`,
    ...prepared,
    title: published.title,
    columnId: options.columnId,
    articleId,
    url: published.url,
    stage: "verified",
  };
  state.receipts.push(receipt);
  options.save();
  await archiveArticle(remnote, options.documentRemId, receipt);
  receipt.stage = "archived";
  options.save();
  return { status: "adopted", published: 0, archived: 1, url: published.url };
}
