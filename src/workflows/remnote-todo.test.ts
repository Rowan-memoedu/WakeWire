import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeStarted,
  ensureQueued,
  eventIdFor,
  isMarked,
  type RemNode,
  type RemNoteReader,
  scanTodo,
  startedTitle,
  type TodoTask,
  taskPrompt,
} from "./remnote-todo.js";

function fixture(nodes: RemNode[], pageSize = 2): RemNoteReader {
  const map = new Map(nodes.map((node) => [node.remId, structuredClone(node)]));
  return {
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
    const remnote = fixture([node]);
    const task = (await scanTodo(remnote, "doc")).tasks[0] as TodoTask;
    expect(await acknowledgeStarted(remnote, task, accepted)).toBe("marked");
    expect(remnote.updateTitle).toHaveBeenCalledExactlyOnceWith(
      "task",
      "**已开始：研究 [[id:exact-target]]** 与 $x^2$",
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
    const remnote = fixture([{ remId: "task", title: "%todo", parentRemId: "doc" }]);
    const task = (await scanTodo(remnote, "doc")).tasks[0] as TodoTask;
    remnote.updateTitle = async () => {
      throw new Error("write unavailable");
    };
    await expect(acknowledgeStarted(remnote, task, accepted)).rejects.toThrow("write unavailable");
    remnote.updateTitle = async () => {};
    await expect(acknowledgeStarted(remnote, task, accepted)).rejects.toThrow("readback mismatch");
  });

  it("only accepts leading single markers and keeps the task prompt within the route limit", () => {
    expect(["%task", "  % task", "**%bold**"].every(isMarked)).toBe(true);
    expect(["%%routine", "text % marker", "%", "ordinary", "**%%routine**"].some(isMarked)).toBe(
      false,
    );
    expect(taskPrompt("root").length).toBeLessThanOrEqual(4000);
    expect(taskPrompt("root")).toContain("直接推进");
  });
});
