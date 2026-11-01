import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeStarted,
  ensureQueued,
  eventIdFor,
  isMarked,
  type RemNode,
  type RemNoteReader,
  relocateStarted,
  scanTodo,
  startedTitle,
  type TodoTask,
} from "./remnote-todo.js";

function fixture(nodes: RemNode[], pageSize = 2): RemNoteReader {
  const map = new Map(nodes.map((node) => [node.remId, structuredClone(node)]));
  return {
    async create(parentRemId, title) {
      const remId = `created-${map.size}`;
      map.set(remId, { remId, parentRemId, title });
      return remId;
    },
    async move(remId, parentRemId, oldParentRemId, position = "last", siblingRemId) {
      const node = map.get(remId);
      if (!node || node.parentRemId !== oldParentRemId) throw new Error("stale parent");
      map.delete(remId);
      node.parentRemId = parentRemId;
      const entries = [...map.entries()];
      const index = entries.findIndex(([id]) => id === siblingRemId);
      if (position === "last") entries.push([remId, node]);
      else entries.splice(index + (position === "after" ? 1 : 0), 0, [remId, node]);
      map.clear();
      for (const [id, item] of entries) map.set(id, item);
    },
    async children(parentRemId, cursor) {
      const children = [...map.values()].filter((node) => node.parentRemId === parentRemId);
      const index = Number(cursor ?? 0);
      return {
        children: children.slice(index, index + pageSize),
        hasMore: index + pageSize < children.length,
        nextCursor: String(index + pageSize),
      };
    },
    async read(remId) {
      const node = map.get(remId);
      if (!node) throw new Error("missing fixture");
      return structuredClone(node);
    },
    updateTitle: vi.fn(async (remId: string, title: string) => {
      const node = map.get(remId);
      if (!node) throw new Error("missing fixture");
      node.title = title.replace(/\[\[id:([^\]]+)\]\]/g, (_match, id: string) => {
        const ref = node.inlineRefs?.find((candidate) => candidate.targetRemId === id);
        return `[[${ref?.text ?? id}]]`;
      });
    }),
  };
}

const accepted = {
  id: "delivery",
  status: "delivering",
  threadId: "native-thread",
  turnId: "native-turn",
  dispatchStarted: true,
};

describe("RemNote marked-todo workflow", () => {
  it("scans every page and chooses self for top-level tasks, parent for nested tasks", async () => {
    const remnote = fixture([
      { remId: "a", parentRemId: "doc", title: "%独立任务" },
      { remId: "a-detail", parentRemId: "a", title: "完整说明" },
      { remId: "b", parentRemId: "doc", title: "已开始：原任务" },
      { remId: "old", parentRemId: "b", title: "已完成兄弟内容" },
      { remId: "new", parentRemId: "b", title: "%新增分支" },
      { remId: "detail", parentRemId: "new", title: "新任务细节" },
      { remId: "plain", parentRemId: "doc", title: "请执行但没有标记" },
      { remId: "routine", parentRemId: "doc", title: "%%例行维护" },
      { remId: "routine-child", parentRemId: "routine", title: "%维护细节" },
      { remId: "infix", parentRemId: "doc", title: "说明里有 % 不触发" },
    ]);
    const scan = await scanTodo(remnote, "doc");
    expect(scan.nodeCount).toBe(10);
    expect(scan.tasks.map(({ taskRemId, contextRemId }) => [taskRemId, contextRemId])).toEqual([
      ["a", "a"],
      ["new", "b"],
    ]);
    expect(scan.conflicts).toEqual([]);
    expect(scan.tasks[0]?.prompt).toBe("- 独立任务\n  - 完整说明");
    expect(scan.tasks[1]?.prompt).toBe(
      "本次任务是下文母项的第 2 个子项及其下属内容，其他部分仅作背景。\n\n" +
        "- 已开始：原任务\n  - 已完成兄弟内容\n  - 新增分支\n    - 新任务细节",
    );
  });

  it("keeps overlapping markers unresolved and refuses broken pagination", async () => {
    const scan = await scanTodo(
      fixture([
        { remId: "parent", parentRemId: "doc", title: "%母项" },
        { remId: "child", parentRemId: "parent", title: "%子项" },
      ]),
      "doc",
    );
    expect(scan.tasks).toEqual([]);
    expect(scan.conflicts.sort()).toEqual(["child", "parent"]);
    const broken = fixture([]);
    broken.children = async () => ({ children: [], hasMore: true });
    await expect(scanTodo(broken, "doc")).rejects.toThrow("pagination");
  });

  it("does not dispatch portal children outside the selected tree", async () => {
    const reader = fixture([]);
    reader.children = async () => ({
      children: [{ remId: "foreign", parentRemId: "other", title: "%不属于本清单" }],
    });
    expect((await scanTodo(reader, "doc")).tasks).toEqual([]);
  });

  it("preserves formatting and exact reference identity when acknowledging a started turn", async () => {
    const node = {
      remId: "task",
      parentRemId: "doc",
      title: "**%研究 [[同名]]** 与 $x^2$",
      inlineRefs: [{ text: "同名", targetRemId: "exact-target" }],
    };
    const remnote = fixture([node, { remId: "started", parentRemId: "doc", title: "已开始" }]);
    const task = (await scanTodo(remnote, "doc")).tasks[0] as TodoTask;
    expect(await acknowledgeStarted(remnote, task, accepted)).toBe("marked");
    expect(remnote.updateTitle).toHaveBeenCalledExactlyOnceWith(
      "task",
      "**研究 [[id:exact-target]]** 与 $x^2$",
    );
    expect(await acknowledgeStarted(remnote, task, accepted)).toBe("already-marked");
    expect(eventIdFor("doc", "task")).toBe(task.sourceDeliveryId);
    expect(eventIdFor("doc", "new-child")).not.toBe(task.sourceDeliveryId);
  });

  it("leaves source edits and unsupported rich titles alone", async () => {
    const remnote = fixture([{ remId: "task", title: "%new user edit", parentRemId: "doc" }]);
    const task = {
      taskRemId: "task",
      title: "%old",
      contextRemId: "task",
      documentRemId: "doc",
      sourceDeliveryId: "stable",
      prompt: "original",
    };
    expect(await acknowledgeStarted(remnote, task, accepted)).toBe("changed");
    expect(remnote.updateTitle).not.toHaveBeenCalled();
    expect(() => startedTitle({ remId: "x", title: "%picture", media: [{}] })).toThrow("lossless");
    expect(() =>
      startedTitle({
        remId: "x",
        title: "%[[same]]",
        inlineRefs: [
          { text: "same", targetRemId: "a" },
          { text: "same", targetRemId: "b" },
        ],
      }),
    ).toThrow("ambiguous");
    await expect(acknowledgeStarted(remnote, task, { ...accepted, turnId: null })).rejects.toThrow(
      "not been acknowledged",
    );
  });

  it.each(["delivering", "delivered", "failed", "queued", "held"])(
    "never re-enqueues a %s receipt, including a marker-write failure",
    async (status) => {
      const task = {
        taskRemId: "task",
        title: "%todo",
        contextRemId: "task",
        documentRemId: "doc",
        sourceDeliveryId: "stable",
        prompt: "original",
      };
      const dispatcher = {
        receipt: vi.fn(async () => ({ ...accepted, status })),
        enqueue: vi.fn(async () => {}),
      };
      await ensureQueued(dispatcher, task);
      expect(dispatcher.enqueue).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge a failed write or a mismatching readback", async () => {
    const remnote = fixture([
      { remId: "task", title: "%todo", parentRemId: "doc" },
      { remId: "started", parentRemId: "doc", title: "已开始" },
    ]);
    const task = (await scanTodo(remnote, "doc")).tasks[0] as TodoTask;
    remnote.updateTitle = async () => {
      throw new Error("write unavailable");
    };
    await expect(acknowledgeStarted(remnote, task, accepted)).rejects.toThrow("write unavailable");
    remnote.updateTitle = async () => {};
    await expect(acknowledgeStarted(remnote, task, accepted)).rejects.toThrow("readback mismatch");
  });

  it("only accepts leading single markers", () => {
    expect(["%task", "  % task", "**%bold**"].every(isMarked)).toBe(true);
    expect(["%%routine", "text % marker", "%", "ordinary", "**%%routine**"].some(isMarked)).toBe(
      false,
    );
  });

  it("moves intact subtrees in order with shared empty separators and retries a failed title write", async () => {
    const reader = fixture(
      [
        { remId: "bucket", parentRemId: "doc", title: "已开始" },
        { remId: "existing-blank", parentRemId: "bucket", title: "" },
        { remId: "a", parentRemId: "doc", title: "%First" },
        { remId: "detail", parentRemId: "a", title: "Original detail" },
        { remId: "b", parentRemId: "doc", title: "已开始：Second" },
      ],
      1,
    );
    const first = (await scanTodo(reader, "doc")).tasks[0] as TodoTask;
    const update = reader.updateTitle;
    reader.updateTitle = async () => {
      throw new Error("temporary write failure");
    };
    await expect(acknowledgeStarted(reader, first, accepted)).rejects.toThrow(
      "temporary write failure",
    );
    expect((await reader.read("a")).title).toBe("%First");
    const retryScan = await scanTodo(reader, "doc");
    expect(retryScan.tasks[0]?.prompt).toBe("- First\n  - Original detail");
    reader.updateTitle = update;
    await acknowledgeStarted(reader, first, accepted);
    await relocateStarted(reader, "doc", await reader.read("b"));
    const siblings: RemNode[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.children("bucket", cursor);
      siblings.push(...page.children);
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
    expect(siblings.map((n) => n.title)).toEqual(["", "First", "", "Second", ""]);
    expect(await reader.read("detail")).toEqual({
      remId: "detail",
      parentRemId: "a",
      title: "Original detail",
    });
    expect((await scanTodo(reader, "doc")).tasks).toEqual([]);
    expect(await acknowledgeStarted(reader, first, accepted)).toBe("already-marked");
  });

  it("mechanically preserves long source text, multiline nodes, definitions and visible references", async () => {
    const longText = "原句不得摘要或截断。".repeat(1500);
    const scan = await scanTodo(
      fixture([
        { remId: "mother", parentRemId: "doc", title: "%研究 RemNote 导出" },
        { remId: "paragraph", parentRemId: "mother", title: longText },
        {
          remId: "term",
          parentRemId: "mother",
          title: "术语",
          headline: "术语 :: 定义第一行\n定义第二行",
        },
        {
          remId: "ref",
          parentRemId: "term",
          title: "参见 [[课程]]",
          inlineRefs: [{ text: "课程", targetRemId: "opaque-rem-id" }],
        },
      ]),
      "doc",
    );
    expect(scan.tasks[0]?.prompt).toBe(
      `- 研究 RemNote 导出\n  - ${longText}\n  - 术语 :: 定义第一行\n    定义第二行\n    - 参见 课程`,
    );
    expect(scan.tasks[0]?.prompt).not.toContain("opaque-rem-id");
    expect(scan.tasks[0]?.prompt).not.toContain("MCP");
  });

  it("locates a nested task without counting empty leaf placeholders", async () => {
    const scan = await scanTodo(
      fixture([
        { remId: "mother", parentRemId: "doc", title: "上下文原文" },
        { remId: "blank", parentRemId: "mother", title: "" },
        { remId: "sibling", parentRemId: "mother", title: "同名事项" },
        { remId: "selected", parentRemId: "mother", title: "%同名事项" },
        { remId: "detail", parentRemId: "selected", title: "实际要做的具体部分" },
      ]),
      "doc",
    );
    expect(scan.tasks[0]?.prompt).toBe(
      "本次任务是下文母项的第 2 个子项及其下属内容，其他部分仅作背景。\n\n" +
        "- 上下文原文\n  - 同名事项\n  - 同名事项\n    - 实际要做的具体部分",
    );
  });
});
