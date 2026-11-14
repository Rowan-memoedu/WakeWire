import { describe, expect, it } from "vitest";
import type { RemNode, RemNoteReader } from "./remnote-todo.js";
import {
  type ArticlePublisher,
  type ArticleState,
  adoptPublishedArticle,
  publicationSlot,
  runArticles,
  saveReviewDraft,
  scanArticles,
  seriesTitle,
  snapshotArticle,
} from "./remnote-zhihu.js";

function fixture() {
  const nodes = new Map<string, RemNode>([
    ["doc", { remId: "doc", title: "Article Source", remType: "document" }],
    ["published", { remId: "published", title: "已发布", parentRemId: "doc" }],
    ["old", { remId: "old", title: "%archived", parentRemId: "published" }],
    ["group", { remId: "group", title: "PRIVATE PARENT", parentRemId: "doc" }],
    ["one", { remId: "one", title: "%first", parentRemId: "group" }],
    ["child", { remId: "child", title: "detail text", parentRemId: "one" }],
    ["sibling", { remId: "sibling", title: "PRIVATE SIBLING", parentRemId: "group" }],
    ["two", { remId: "two", title: "%second", parentRemId: "doc" }],
    ["child2", { remId: "child2", title: "second detail", parentRemId: "two" }],
  ]);
  const remnote: RemNoteReader = {
    async read(id) {
      const node = nodes.get(id);
      if (!node) throw new Error("not found");
      return structuredClone(node);
    },
    async children(id) {
      return {
        children: [...nodes.values()]
          .filter((n) => n.parentRemId === id)
          .map((n) => structuredClone(n)),
        hasMore: false,
      };
    },
    async create(parentRemId, title) {
      const remId = `new-${nodes.size}`;
      nodes.set(remId, { remId, parentRemId, title });
      return remId;
    },
    async updateTitle(id, title) {
      (nodes.get(id) as RemNode).title = title;
    },
    async move(id, parent, expected) {
      const node = nodes.get(id) as RemNode;
      if (node.parentRemId !== expected) throw new Error("parent mismatch");
      node.parentRemId = parent;
    },
  };
  const state: ArticleState = { receipts: [] };
  let posts = 0;
  let persisted = "";
  const publisher: ArticlePublisher = {
    async prepare(rows) {
      const text = rows
        .slice(1)
        .map((n) => n.text)
        .join("");
      return { title: rows[0]?.text ?? "", html: `<p>${text}</p>`, text, format: "[]" };
    },
    async check() {
      return { id: "account", name: "author", urlToken: "author", columnId: "col" };
    },
    async publish() {
      posts++;
      return { id: String(100 + posts) };
    },
    async verify(id) {
      return {
        id,
        authorId: "account",
        title: state.receipts.at(-1)?.title ?? "",
        text: state.receipts.at(-1)?.text ?? "",
        format: "[]",
        columnIds: ["col"],
        url: `https://zhuanlan.zhihu.com/p/${id}`,
      };
    },
  };
  const options = {
    remnote,
    publisher,
    documentRemId: "doc",
    accountId: "account",
    columnId: "col",
    state,
    save: () => {
      persisted = JSON.stringify(state);
    },
    now: new Date("2026-11-14T03:30:00Z"),
  };
  return {
    nodes,
    remnote,
    state,
    publisher,
    options,
    posts: () => posts,
    persisted: () => persisted,
  };
}

describe("RemNote to Zhihu publishing", () => {
  it("uses Shanghai windows and never catches up missed windows", () => {
    expect(publicationSlot(new Date("2026-11-14T03:29:59Z"))).toBeUndefined();
    expect(publicationSlot(new Date("2026-11-14T03:30:00Z"))).toBe("2026-11-14T11:30+08:00");
    expect(publicationSlot(new Date("2026-11-14T09:44:59Z"))).toBe("2026-11-14T17:30+08:00");
    expect(publicationSlot(new Date("2026-11-14T14:30:00Z"))).toBe("2026-11-14T22:30+08:00");
    expect(publicationSlot(new Date("2026-11-14T14:45:00Z"))).toBeUndefined();
    expect(publicationSlot(new Date("2026-11-14T15:30:00Z"))).toBeUndefined();
  });
  it("scans depth first, excludes archives, and exports only the marked subtree", async () => {
    const f = fixture();
    const scan = await scanArticles(f.remnote, "doc");
    expect(scan.sources.map((s) => s.remId)).toEqual(["one", "two"]);
    expect(scan.sources[0]?.nodes.map((n) => n.text)).toEqual(["first", "detail text"]);
  });
  it("keeps the bound Document identity when its display title is renamed", async () => {
    const f = fixture();
    (f.nodes.get("doc") as RemNode).title = "Renamed Article Source";
    expect((await scanArticles(f.remnote, "doc")).sources.map((source) => source.remId)).toEqual([
      "one",
      "two",
    ]);
  });
  it("keeps ambiguous parent/child markers together and publishes neither", async () => {
    const f = fixture();
    (f.nodes.get("child") as RemNode).title = "%nested";
    const scan = await scanArticles(f.remnote, "doc");
    expect(scan.blocked).toEqual(["one"]);
    expect(scan.sources.map((s) => s.remId)).toEqual(["two"]);
  });
  it("treats double percent as a disabled subtree", async () => {
    const f = fixture();
    (f.nodes.get("group") as RemNode).title = "%%hold";
    expect((await scanArticles(f.remnote, "doc")).sources.map((s) => s.remId)).toEqual(["two"]);
  });
  it("blocks media and unresolved references instead of silently omitting them", async () => {
    const f = fixture();
    (f.nodes.get("child") as RemNode).media = [{}];
    await expect(snapshotArticle(f.remnote, "one")).rejects.toThrow("media");
    delete (f.nodes.get("child") as RemNode).media;
    (f.nodes.get("child") as RemNode).title = "[[unknown]]";
    await expect(snapshotArticle(f.remnote, "one")).rejects.toThrow("unresolved");
  });
  it("resolves explicit references as visible text without reading referenced subtrees", async () => {
    const f = fixture();
    Object.assign(f.nodes.get("child") as RemNode, {
      title: "[[id:elsewhere]]",
      inlineRefs: [{ targetRemId: "elsewhere", text: "label" }],
    });
    expect((await snapshotArticle(f.remnote, "one")).nodes[1]?.text).toBe("label");
  });
  it("publishes one article, verifies it, and moves the same original tree", async () => {
    const f = fixture();
    expect(await runArticles(f.options)).toMatchObject({ published: 1, archived: 1 });
    expect(f.nodes.get("one")).toMatchObject({ parentRemId: "published", title: "first" });
    expect(f.nodes.get("child")?.parentRemId).toBe("one");
    expect(f.nodes.get("two")?.title).toBe("%second");
    expect(f.state.receipts[0]?.stage).toBe("archived");
    expect(f.state.receipts[0]?.url).toBe("https://zhuanlan.zhihu.com/p/101");
    expect(f.persisted()).not.toContain("PRIVATE");
  });
  it("does not publish twice in one slot even if another node is pending", async () => {
    const f = fixture();
    await runArticles(f.options);
    await runArticles(f.options);
    expect(f.posts()).toBe(1);
    f.options.now = new Date("2026-11-14T09:30:00Z");
    await runArticles(f.options);
    expect(f.posts()).toBe(2);
  });
  it("does not mutate anything outside publication windows", async () => {
    const f = fixture();
    f.options.now = new Date("2026-11-14T02:00:00Z");
    expect((await runArticles(f.options)).status).toBe("outside-window");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toEqual([]);
  });
  it("does not post if scanning outlasts the original publication window", async () => {
    const f = fixture();
    const result = await runArticles({
      ...f.options,
      currentTime: () => new Date("2026-11-14T03:46:00Z"),
    });
    expect(result.status).toBe("window-ended");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toEqual([]);
  });
  it("fails closed when account identity changes", async () => {
    const f = fixture();
    f.publisher.check = async () => ({
      id: "other",
      name: "other",
      urlToken: "other",
      columnId: "col",
    });
    await expect(runArticles(f.options)).rejects.toThrow("account changed");
    expect(f.posts()).toBe(0);
  });
  it("rechecks source edits before the POST", async () => {
    const f = fixture();
    const check = f.publisher.check;
    f.publisher.check = async () => {
      (f.nodes.get("child") as RemNode).title = "edited";
      return check();
    };
    await expect(runArticles(f.options)).rejects.toThrow("source changed");
    expect(f.posts()).toBe(0);
  });
  it("persists the submission fence before posting and never replays an unknown result", async () => {
    const f = fixture();
    f.publisher.publish = async () => {
      expect(JSON.parse(f.persisted()).receipts[0].stage).toBe("submitting");
      throw new Error("connection lost");
    };
    await expect(runArticles(f.options)).rejects.toThrow("connection lost");
    await expect(runArticles(f.options)).rejects.toThrow("unknown publication");
    expect(f.nodes.get("one")?.parentRemId).toBe("group");
  });
  it("never posts if saving the fence fails", async () => {
    const f = fixture();
    f.options.save = () => {
      throw new Error("disk full");
    };
    await expect(runArticles(f.options)).rejects.toThrow("disk full");
    expect(f.posts()).toBe(0);
  });
  it("retains the source if public content or author does not match", async () => {
    const f = fixture();
    f.publisher.verify = async (id) => ({
      id,
      authorId: "other",
      title: "wrong",
      text: "wrong",
      format: "[]",
      columnIds: ["col"],
      url: `https://zhuanlan.zhihu.com/p/${id}`,
    });
    await expect(runArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.state.receipts[0]?.stage).toBe("published");
    expect(f.nodes.get("one")?.parentRemId).toBe("group");
  });
  it("recovers a verified publication after move failure without posting again", async () => {
    const f = fixture();
    const move = f.remnote.move;
    f.remnote.move = async () => {
      throw new Error("bridge unavailable");
    };
    await expect(runArticles(f.options)).rejects.toThrow("bridge unavailable");
    expect(f.posts()).toBe(1);
    f.remnote.move = move;
    f.options.now = new Date("2026-11-14T05:00:00Z");
    expect((await runArticles(f.options)).archived).toBe(1);
    expect(f.posts()).toBe(1);
  });
  it("recovers after a move succeeded but the marker update failed", async () => {
    const f = fixture();
    const update = f.remnote.updateTitle;
    f.remnote.updateTitle = async () => {
      throw new Error("write failed");
    };
    await expect(runArticles(f.options)).rejects.toThrow("write failed");
    expect(f.nodes.get("one")?.parentRemId).toBe("published");
    expect(f.nodes.get("one")?.title).toBe("%first");
    f.remnote.updateTitle = update;
    await runArticles(f.options);
    expect(f.posts()).toBe(1);
    expect(f.nodes.get("one")?.title).toBe("first");
  });
  it("preserves edits made after posting and does not archive changed content", async () => {
    const f = fixture();
    const verify = f.publisher.verify;
    f.publisher.verify = async (id) => {
      (f.nodes.get("child") as RemNode).title = "new draft";
      return verify(id);
    };
    await expect(runArticles(f.options)).rejects.toThrow("source changed after");
    expect(f.nodes.get("child")?.title).toBe("new draft");
    expect(f.nodes.get("one")?.parentRemId).toBe("group");
  });
  it("blocks same content in another source node", async () => {
    const f = fixture();
    await runArticles(f.options);
    Object.assign(f.nodes.get("two") as RemNode, { title: "%first" });
    Object.assign(f.nodes.get("child2") as RemNode, { title: "detail text" });
    f.options.now = new Date("2026-11-14T09:30:00Z");
    await expect(runArticles(f.options)).rejects.toThrow("duplicate article");
    expect(f.posts()).toBe(1);
  });
  it("rejects changed list structure even when all visible words match", async () => {
    const f = fixture();
    const verify = f.publisher.verify;
    f.publisher.verify = async (id) => ({ ...(await verify(id)), format: "[flattened]" });
    await expect(runArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.nodes.get("one")?.parentRemId).toBe("group");
  });
  it("requires an exact Document and complete pagination", async () => {
    const f = fixture();
    (f.nodes.get("doc") as RemNode).remType = "text";
    await expect(scanArticles(f.remnote, "doc")).rejects.toThrow("Document");
    (f.nodes.get("doc") as RemNode).remType = "document";
    f.remnote.children = async () => ({ children: [], hasMore: true });
    await expect(scanArticles(f.remnote, "doc")).rejects.toThrow("pagination");
  });
  it("retains a published source until its configured column has accepted it", async () => {
    const f = fixture();
    const verify = f.publisher.verify;
    f.publisher.verify = async (id) => ({ ...(await verify(id)), columnIds: [] });
    await expect(runArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.state.receipts[0]?.stage).toBe("published");
    expect(f.nodes.get("one")?.parentRemId).toBe("group");
    f.publisher.verify = verify;
    await runArticles(f.options);
    expect(f.posts()).toBe(1);
    expect(f.nodes.get("one")?.parentRemId).toBe("published");
  });
  it("adopts an explicitly identified matching manual publication without another POST", async () => {
    const f = fixture();
    const prepared = await f.publisher.prepare((await snapshotArticle(f.remnote, "one")).nodes);
    f.publisher.verify = async (id) => ({
      ...prepared,
      id,
      authorId: "account",
      title: "Author's manual title",
      columnIds: ["col"],
      url: `https://zhuanlan.zhihu.com/p/${id}`,
    });
    const options = { ...f.options, sourceRemId: "one", articleId: "123" };
    expect(await adoptPublishedArticle(options)).toMatchObject({
      status: "adopted",
      published: 0,
      archived: 1,
    });
    expect(f.posts()).toBe(0);
    expect(f.nodes.get("one")).toMatchObject({ title: "first", parentRemId: "published" });
    expect(f.state.receipts[0]?.title).toBe("Author's manual title");
    expect((await adoptPublishedArticle(options)).status).toBe("already-adopted");
    expect(f.state.receipts).toHaveLength(1);
  });
  it("refuses to adopt a manual article with different layout or column", async () => {
    const f = fixture();
    const prepared = await f.publisher.prepare((await snapshotArticle(f.remnote, "one")).nodes);
    f.publisher.verify = async (id) => ({
      ...prepared,
      format: "wrong-layout",
      id,
      authorId: "account",
      columnIds: ["col"],
      url: `https://zhuanlan.zhihu.com/p/${id}`,
    });
    await expect(
      adoptPublishedArticle({ ...f.options, sourceRemId: "one", articleId: "123" }),
    ).rejects.toThrow("does not match");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toHaveLength(0);
    expect(f.nodes.get("one")?.parentRemId).toBe("group");
  });
  it("numbers published articles and calendar days separately in Shanghai", () => {
    const state: ArticleState = { receipts: [] };
    expect(
      seriesTitle(
        "Title",
        new Date("2026-11-13T16:01:00Z"),
        "2026-11-13",
        { publishedCount: 1, maxOrdinal: 1 },
        state,
      ),
    ).toBe("Title（第2 篇 | day 2）");
    expect(
      seriesTitle(
        "Title（第7 篇 | day 5）",
        new Date("2026-11-14T12:00:00Z"),
        "2026-11-13",
        { publishedCount: 4, maxOrdinal: 7 },
        state,
      ),
    ).toBe("Title（第8 篇 | day 2）");
    expect(() =>
      seriesTitle(
        "Title",
        new Date("2026-11-14T12:00:00Z"),
        "2026-02-30",
        { publishedCount: 1, maxOrdinal: 1 },
        state,
      ),
    ).toThrow("start date");
    expect(() =>
      seriesTitle(
        "T".repeat(100),
        new Date("2026-11-14T12:00:00Z"),
        "2026-11-13",
        { publishedCount: 1, maxOrdinal: 1 },
        state,
      ),
    ).toThrow("exceeds");
  });
  it("uses the highest recorded ordinal even if an older article was removed from the column", async () => {
    const f = fixture();
    await runArticles(f.options);
    (f.state.receipts[0] as NonNullable<(typeof f.state.receipts)[0]>).title =
      "first（第9 篇 | day 1）";
    expect(
      seriesTitle(
        "Next",
        new Date("2026-11-14T10:00:00Z"),
        "2026-11-13",
        { publishedCount: 1, maxOrdinal: 1 },
        f.state,
      ),
    ).toBe("Next（第10 篇 | day 2）");
  });
  it("stores a real draft for review without consuming a publication or moving its source", async () => {
    const f = fixture();
    let creates = 0;
    let cloud = {
      id: "777",
      authorId: "account",
      title: "",
      text: "",
      format: "[]",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    };
    f.publisher.seriesStats = async () => ({ publishedCount: 1, maxOrdinal: 1 });
    f.publisher.createDraft = async () => {
      creates++;
      expect(JSON.parse(f.persisted()).drafts[0].status).toBe("creating");
      return { id: "777" };
    };
    f.publisher.readDraft = async () => ({ ...cloud });
    f.publisher.writeDraft = async (id, title, html) => {
      expect(JSON.parse(f.persisted()).drafts[0].draftId).toBe("777");
      cloud = { ...cloud, id, title, text: html.replace(/<[^>]+>/gu, "") };
      return { ...cloud };
    };
    const result = await saveReviewDraft({
      ...f.options,
      seriesStartDate: "2026-11-13",
      sourceRemId: "one",
    });
    expect(result).toMatchObject({
      status: "draft-review",
      title: "first（第2 篇 | day 2）",
      published: 0,
      moved: 0,
    });
    expect(f.state.receipts).toHaveLength(0);
    expect(f.nodes.get("one")?.title).toBe("%first");
    await saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" });
    expect(creates).toBe(1);
    // A held preview is skipped, so another eligible article can still be published.
    const draftCreator = f.publisher.createDraft;
    delete f.publisher.createDraft; // This fixture's creator is scoped to the review draft.
    await runArticles(f.options);
    f.publisher.createDraft = draftCreator;
    expect(f.state.receipts[0]?.source.remId).toBe("two");
    expect(f.posts()).toBe(1);
    cloud.title = "Author edit";
    await expect(
      saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" }),
    ).rejects.toThrow("author edits");
    expect(cloud.title).toBe("Author edit");
  });
  it("does not recreate a draft after an unknown creation result", async () => {
    const f = fixture();
    let attempts = 0;
    f.publisher.seriesStats = async () => ({ publishedCount: 1, maxOrdinal: 1 });
    f.publisher.createDraft = async () => {
      attempts++;
      throw new Error("connection lost");
    };
    f.publisher.readDraft = async () => {
      throw new Error("must not read an unknown ID");
    };
    f.publisher.writeDraft = async () => {
      throw new Error("must not write");
    };
    await expect(
      saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" }),
    ).rejects.toThrow("connection lost");
    await expect(
      saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" }),
    ).rejects.toThrow("unknown draft");
    expect(attempts).toBe(1);
    expect(f.posts()).toBe(0);
  });
  it("publishes an approved draft using the saved cloud identity and final series title", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "one");
    const prepared = await f.publisher.prepare(source.nodes);
    const title = "first（第2 篇 | day 2）";
    f.state.drafts = [{ source, ...prepared, title, status: "ready", draftId: "777" }];
    f.publisher.seriesStats = async () => ({ publishedCount: 1, maxOrdinal: 1 });
    f.publisher.readDraft = async () => ({
      ...prepared,
      title,
      id: "777",
      authorId: "account",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    });
    let calls = 0;
    f.publisher.publish = async (actualTitle, _html, draft) => {
      calls++;
      expect(draft?.draftId).toBe("777");
      expect(actualTitle).toBe(title);
      return { id: "777" };
    };
    await runArticles({ ...f.options, seriesStartDate: "2026-11-13" });
    expect(calls).toBe(1);
    expect(f.state.receipts[0]?.articleId).toBe("777");
    expect(f.state.drafts[0]?.status).toBe("published");
    expect(f.nodes.get("one")?.parentRemId).toBe("published");
  });
  it("preserves cloud edits made after draft approval", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "one");
    const prepared = await f.publisher.prepare(source.nodes);
    f.state.drafts = [{ source, ...prepared, status: "ready", draftId: "777" }];
    f.publisher.readDraft = async () => ({
      ...prepared,
      text: "Author changed body",
      id: "777",
      authorId: "account",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    });
    await expect(runArticles(f.options)).rejects.toThrow("cloud draft changed");
    expect(f.posts()).toBe(0);
  });
  it("persists a newly provisioned cloud ID and recovers publication by readback without replay", async () => {
    const f = fixture();
    let creates = 0;
    let attempts = 0;
    f.publisher.createDraft = async () => {
      creates++;
      return { id: "777" };
    };
    f.publisher.readDraft = async () => ({
      id: "777",
      authorId: "account",
      title: "",
      text: "",
      format: "[]",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    });
    f.publisher.publish = async (_title, _html, draft) => {
      attempts++;
      expect(draft?.draftId).toBe("777");
      expect(draft?.cloudBefore?.title).toBe("");
      expect(JSON.parse(f.persisted()).receipts[0].articleId).toBe("777");
      throw new Error("response lost after publish");
    };
    await expect(runArticles(f.options)).rejects.toThrow("response lost");
    expect(f.state.receipts[0]?.stage).toBe("submitting");
    const recovered = await runArticles(f.options);
    expect(recovered.archived).toBe(1);
    expect(f.state.receipts[0]?.stage).toBe("archived");
    expect(attempts).toBe(1);
    expect(creates).toBe(1);
  });
  it("does not replay a known draft when public readback still says unpublished", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "one");
    const prepared = await f.publisher.prepare(source.nodes);
    f.state.receipts.push({
      source,
      ...prepared,
      stage: "submitting",
      articleId: "777",
      columnId: "col",
      slot: "earlier",
    });
    f.publisher.verify = async () => {
      throw new Error("article_not_published");
    };
    await expect(runArticles(f.options)).rejects.toThrow("article_not_published");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts[0]?.stage).toBe("submitting");
  });
  it("detects repeated content despite the publication series suffix", async () => {
    const f = fixture();
    await runArticles(f.options);
    const receipt = f.state.receipts[0];
    if (!receipt) throw new Error("missing fixture receipt");
    receipt.title = "first（第1 篇 | day 1）";
    const second = f.nodes.get("two");
    const body = f.nodes.get("child2");
    if (!second || !body) throw new Error("missing fixture nodes");
    second.title = "%first";
    body.title = "detail text";
    await expect(
      runArticles({ ...f.options, now: new Date("2026-11-14T09:30:00Z") }),
    ).rejects.toThrow("duplicate article");
    expect(f.posts()).toBe(1);
  });
});
