import { describe, expect, it, vi } from "vitest";
import { acknowledgeBatch, maintenanceBatch } from "./remnote-command-batch.js";
import { CommandSourceSchema, scanCommandSource } from "./remnote-command-sources.js";
import type { RemNode, RemNoteReader, TodoReceipt } from "./remnote-todo.js";

function fixture(titles: string[]) {
  const nodes = new Map<string, RemNode>([
    ["doc", { remId: "doc", title: "维护 Document", remType: "document" }],
    ["started", { remId: "started", title: "已开始", parentRemId: "doc" }],
    ...titles.map((title, i): [string, RemNode] => [
      `task-${i}`,
      { remId: `task-${i}`, title, parentRemId: "doc" },
    ]),
  ]);
  const reader: RemNoteReader = {
    children: async (parent) => ({
      children: [...nodes.values()]
        .filter((n) => n.parentRemId === parent)
        .map((n) => structuredClone(n)),
    }),
    read: async (id) => {
      const node = nodes.get(id);
      if (!node) throw new Error("missing");
      return structuredClone(node);
    },
    create: async (parentRemId, title) => {
      const remId = `new-${nodes.size}`;
      nodes.set(remId, { remId, parentRemId, title });
      return remId;
    },
    move: async (id, parentRemId, oldParent) => {
      const node = nodes.get(id);
      if (node?.parentRemId !== oldParent) throw new Error("stale move");
      node.parentRemId = parentRemId;
    },
    updateTitle: vi.fn(async (id, title) => {
      const node = nodes.get(id);
      if (!node) throw new Error("missing");
      node.title = title;
    }),
  };
  const source = CommandSourceSchema.parse({
    documentRemId: "doc",
    title: "维护",
    scope: "合成维护范围",
  });
  const scan = async () => (await scanCommandSource(reader, source, new Set())).tasks;
  return { reader, nodes, scan };
}
const accepted: TodoReceipt = {
  id: "delivery",
  status: "delivering",
  threadId: "thread",
  turnId: "turn",
  dispatchStarted: true,
};

describe("maintenance batches and sequence advancement", () => {
  it("puts all unnumbered tasks in one parallel batch and keeps other Documents independent", async () => {
    const f = fixture(["%第一条", "%第二条"]);
    const tasks = await f.scan();
    const batch = maintenanceBatch(tasks);
    expect(batch?.prompt).toBe("- 第一条\n\n- 第二条");
    expect(batch?.commandBatch?.members).toHaveLength(2);
    expect(batch?.commandBatch?.renumber).toEqual([]);
    expect(maintenanceBatch([...tasks].reverse())?.sourceDeliveryId).toBe(batch?.sourceDeliveryId);
    expect(
      maintenanceBatch(tasks.map((t) => ({ ...t, documentRemId: "another" })))?.sourceDeliveryId,
    ).not.toBe(batch?.sourceDeliveryId);
  });

  it("gives unnumbered items their own first batch, then sends only the first numbered group on the next scan", async () => {
    const f = fixture(["%2后批", "%未编号甲", "%1前批甲", "%未编号乙", "%1前批乙", "%3末批"]);
    const first = maintenanceBatch(await f.scan());
    expect(first?.commandBatch?.members.map((m) => m.title)).toEqual(["%未编号甲", "%未编号乙"]);
    await acknowledgeBatch(
      f.reader,
      first?.commandBatch as NonNullable<typeof first>["commandBatch"] & {},
      accepted,
    );
    expect(f.nodes.get("task-0")?.title).toBe("%2后批");
    const second = maintenanceBatch(await f.scan());
    expect(second?.prompt).toBe("- 前批甲\n\n- 前批乙");
    expect(second?.commandBatch?.members.map((m) => m.title)).toEqual(["%1前批甲", "%1前批乙"]);
    await acknowledgeBatch(
      f.reader,
      second?.commandBatch as NonNullable<typeof second>["commandBatch"] & {},
      accepted,
    );
    expect(f.nodes.get("task-0")?.title).toBe("%1后批");
    expect(f.nodes.get("task-5")?.title).toBe("%2末批");
    expect(f.nodes.get("task-2")?.title).toBe("前批甲");
    expect(f.nodes.get("task-2")?.parentRemId).toBe("started");
    expect(maintenanceBatch(await f.scan())?.prompt).toBe("- 后批");
  });

  it("does not move or renumber failed or unknown dispatches", async () => {
    const f = fixture(["%1首批", "%2后批"]);
    const batch = maintenanceBatch(await f.scan());
    await expect(
      acknowledgeBatch(
        f.reader,
        batch?.commandBatch as NonNullable<typeof batch>["commandBatch"] & {},
        { ...accepted, threadId: null, turnId: null },
      ),
    ).rejects.toThrow("not accepted");
    expect(f.nodes.get("task-0")?.title).toBe("%1首批");
    expect(f.nodes.get("task-1")?.title).toBe("%2后批");
    expect(f.reader.updateTitle).not.toHaveBeenCalled();
  });

  it("recovers partially placed and partially renumbered batches without subtracting twice", async () => {
    const f = fixture(["%1首批甲", "%1首批乙", "%2后批", "%3末批"]);
    const batch = maintenanceBatch(await f.scan());
    const plan = batch?.commandBatch;
    if (!plan) throw new Error("missing batch");
    const originalUpdate = f.reader.updateTitle;
    let fail = true;
    f.reader.updateTitle = async (id, title) => {
      if (id === "task-1" && fail) {
        fail = false;
        throw new Error("temporary placement failure");
      }
      return originalUpdate(id, title);
    };
    await expect(acknowledgeBatch(f.reader, plan, accepted)).rejects.toThrow("temporary");
    expect(f.nodes.get("task-0")?.title).toBe("首批甲");
    fail = true;
    f.reader.updateTitle = async (id, title) => {
      if (id === "task-3" && fail) {
        fail = false;
        throw new Error("temporary numbering failure");
      }
      return originalUpdate(id, title);
    };
    await expect(acknowledgeBatch(f.reader, plan, accepted)).rejects.toThrow("temporary");
    expect(f.nodes.get("task-2")?.title).toBe("%1后批");
    await acknowledgeBatch(f.reader, plan, accepted);
    await acknowledgeBatch(f.reader, plan, accepted);
    expect(f.nodes.get("task-2")?.title).toBe("%1后批");
    expect(f.nodes.get("task-3")?.title).toBe("%2末批");
  });

  it("preserves edits instead of renumbering over concurrent changes", async () => {
    const f = fixture(["%1首批", "%2后批"]);
    const batch = maintenanceBatch(await f.scan());
    const later = f.nodes.get("task-1");
    if (later) later.title = "%4用户修改";
    await expect(
      acknowledgeBatch(
        f.reader,
        batch?.commandBatch as NonNullable<typeof batch>["commandBatch"] & {},
        accepted,
      ),
    ).rejects.toThrow("later sequence changed");
    expect(later?.title).toBe("%4用户修改");
  });

  it.each(["task-0", "task-1"])(
    "does not reclaim or renumber a task moved by the user: %s",
    async (id) => {
      const f = fixture(["%1首批", "%2后批"]);
      const plan = maintenanceBatch(await f.scan())?.commandBatch;
      if (!plan) throw new Error("missing batch");
      const node = f.nodes.get(id);
      if (node) node.parentRemId = "outside";
      await expect(acknowledgeBatch(f.reader, plan, accepted)).rejects.toThrow("moved by user");
      expect(node?.parentRemId).toBe("outside");
      expect(node?.title).toBe(id === "task-0" ? "%1首批" : "%2后批");
    },
  );

  it("orders numerically rather than lexically and leaves original task text intact", async () => {
    const f = fixture(["%10第十批", "**%2 第二批**", "%3第三批"]);
    expect(maintenanceBatch(await f.scan())?.prompt).toBe("- ** 第二批**");
  });
});
