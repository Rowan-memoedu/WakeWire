import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { type ArticleRem, type ArticleState, runArticles } from "./remnote-zhihu.js";
import { ArticleRemNoteMcp } from "./remnote-zhihu-cli.js";

it("runs the external tag workflow through a real MCP HTTP transport without moving the source", async () => {
  const nodes = new Map<string, ArticleRem>([
    ["doc", { remId: "doc", title: "Publication Document", remType: "document" }],
    ["done", { remId: "done", title: "已发布", parentRemId: "doc" }],
    ["other", { remId: "other", title: "Independent document", remType: "document" }],
    [
      "source",
      {
        remId: "source",
        title: "%Transport canary",
        parentRemId: "other",
        tags: [
          { tagRemId: "doc", name: "Publication Document" },
          { tagRemId: "keep", name: "Unrelated" },
        ],
      },
    ],
    ["body", { remId: "body", title: "Independent full article content", parentRemId: "source" }],
  ]);
  const mutations: string[] = [];
  const server = new Server(
    { name: "isolated-tag-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    let value: Record<string, unknown>;
    switch (params.name) {
      case "remnote_status":
        value = { connected: true, acceptWriteOperations: true };
        break;
      case "remnote_read_note":
        value = { ...nodes.get(String(args.remId)) };
        break;
      case "remnote_list_children":
        value = {
          children: [...nodes.values()].filter((node) => node.parentRemId === args.parentRemId),
          hasMore: false,
        };
        break;
      case "remnote_search_by_tag":
        expect(args.resultMode).toBe("tagged");
        value = {
          results: [...nodes.values()].filter((node) =>
            node.tags?.some((tag) => tag.tagRemId === args.tagRemId),
          ),
          hasMore: false,
        };
        break;
      case "remnote_update_tags": {
        mutations.push(params.name);
        const node = nodes.get(String(args.remId)) as ArticleRem;
        const remove = args.removeTagRemIds as string[];
        node.tags = (node.tags ?? []).filter((tag) => !remove.includes(tag.tagRemId));
        for (const tagRemId of args.addTagRemIds as string[])
          if (!node.tags.some((tag) => tag.tagRemId === tagRemId))
            node.tags.push({ tagRemId, name: tagRemId });
        value = { remIds: [node.remId], titles: [node.title] };
        break;
      }
      case "remnote_update_note": {
        mutations.push(params.name);
        const node = nodes.get(String(args.remId)) as ArticleRem;
        node.title = String(args.title);
        value = { remIds: [node.remId], titles: [node.title] };
        break;
      }
      default:
        throw new Error(`Unexpected mutation or tool: ${params.name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport as Transport);
  const http = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture listener missing");
  const reader = new ArticleRemNoteMcp();
  const state: ArticleState = { receipts: [] };
  let publications = 0;
  try {
    await reader.connect(`http://127.0.0.1:${address.port}/mcp`);
    const result = await runArticles({
      remnote: reader,
      documentRemId: "doc",
      publishedTagRemId: "done",
      accountId: "owner",
      columnId: "column",
      state,
      now: new Date("2026-11-14T03:30:00Z"),
      save: () => {},
      publisher: {
        prepare: async (rows) => ({
          title: rows[0]?.text ?? "",
          html: "<p>Independent full article content</p>",
          text: "Independent full article content",
          format: "fixture-layout",
        }),
        check: async () => ({ id: "owner", columnId: "column", name: "Owner", urlToken: "owner" }),
        publish: async () => {
          publications++;
          return { id: "900" };
        },
        verify: async (id) => ({
          id,
          authorId: "owner",
          title: "Transport canary",
          text: "Independent full article content",
          format: "fixture-layout",
          columnIds: ["column"],
          url: `https://zhuanlan.zhihu.com/p/${id}`,
        }),
      },
    });
    expect(result).toMatchObject({ published: 1, archived: 1 });
    expect(publications).toBe(1);
    expect(nodes.get("source")).toMatchObject({ title: "Transport canary", parentRemId: "other" });
    expect(
      nodes
        .get("source")
        ?.tags?.map((tag) => tag.tagRemId)
        .sort(),
    ).toEqual(["done", "keep"]);
    expect(mutations).toEqual([
      "remnote_update_tags",
      "remnote_update_tags",
      "remnote_update_note",
    ]);
  } finally {
    await reader.close();
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
