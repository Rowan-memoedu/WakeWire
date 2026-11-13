import { describe, expect, it } from "vitest";
import type { RemNode, RemNoteReader } from "./remnote-todo.js";
import {
  type ArticlePublisher,
  type ArticleState,
  publicationSlot,
  runArticles,
  scanArticles,
  snapshotArticle,
} from "./remnote-zhihu.js";

function fixture() {
  const nodes = new Map<string, RemNode>([
    ["doc", { remId: "doc", title: "知乎想法", remType: "document" }],
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
      return { id: "account", name: "author", urlToken: "author" };
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
        url: `https://zhuanlan.zhihu.com/p/${id}`,
      };
    },
  };
  const options = {
    remnote,
    publisher,
    documentRemId: "doc",
    accountId: "account",
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
  it("fails closed when account identity changes", async () => {
    const f = fixture();
    f.publisher.check = async () => ({ id: "other", name: "other", urlToken: "other" });
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
});
