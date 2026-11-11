import { z } from "zod";
import {
  allChildren,
  eventIdFor,
  type RemNoteReader,
  scanTodo,
  type TodoReceipt,
  type TodoTask,
} from "./remnote-todo.js";

const RemId = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const CommandSourceSchema = z.object({
  documentRemId: RemId,
  title: z.string().min(1),
  scope: z.string().min(1).optional(),
  legacyReceipts: z
    .array(z.object({ documentRemId: RemId, routeId: z.string().min(1) }))
    .default([]),
});
export const MaintenanceDocumentsSchema = z
  .object({
    rootRemId: RemId,
    documents: z.array(CommandSourceSchema.extend({ scope: z.string().min(1) })).min(1),
  })
  .superRefine((config, ctx) => {
    const ids = config.documents.map((source) => source.documentRemId);
    if (new Set(ids).size !== ids.length || ids.includes(config.rootRemId))
      ctx.addIssue({
        code: "custom",
        message: "maintenance document IDs must be distinct from each other and the root",
      });
  });
export type CommandSource = z.infer<typeof CommandSourceSchema>;
export type MaintenanceDocuments = z.infer<typeof MaintenanceDocumentsSchema>;

export async function findLegacyReceipt(
  source: CommandSource,
  taskRemId: string,
  lookup: (routeId: string, sourceDeliveryId: string) => Promise<TodoReceipt | undefined>,
): Promise<TodoReceipt | undefined> {
  for (const identity of source.legacyReceipts) {
    const receipt = await lookup(identity.routeId, eventIdFor(identity.documentRemId, taskRemId));
    if (receipt) return receipt;
  }
  return undefined;
}

export function maintenanceInstructions(source: CommandSource): string | undefined {
  if (!source.scope) return undefined;
  return `你正在处理「${source.title}」中的维护任务。
对应对象与工作范围：${source.scope}
先恢复对应项目或工作流的现状，阅读相关 README、AGENTS.md、现有配置和维护入口，再按用户任务确定实际涉及的部分。范围说明提供上下文，不代表要改动列出的全部项目；没有具体仓库绑定时，先根据任务查找真实实现，不臆造对应关系。
用户消息是按原文和层级导出的任务；其中标明仅作背景的部分保持为背景。沿用用户已有协作约定、讨论要求和授权边界，不把任务标记当作跳过真实未决决策的许可。
完成任务所需的配套工程工作：保留他人改动，运行相应检查；按各仓库约定只提交本任务文件，推送并创建或更新 PR，检查通过后完成可安全进行的合并，获取主分支最新状态并对齐本地源码。跨仓库变更分别提交并说明依赖与合并顺序。存在真实冲突、检查失败或权限阻塞时保留现场，在当前 Thread 说明，不冒充完成。
同步本次变更涉及的说明文档、配置示例、代码、构建和已安装或部署的运行文件；发布后核验实际运行版本与健康状态。无需变更的项目不制造提交或 PR。使用项目已有 CI 与交付方式，不强制通过旧 SoftwareMaintenance 中心或其专用 CLI。
不得上传密钥、私人材料或运行数据。软件更新沿用现有授权；内容的初次对外发布仍按用户约定确认。RemNote 业务内容的写入仅限任务明确授权的范围；投递系统负责命令受理归位，不因执行或合并完成而自动标记 RemNote 事项完成。`;
}

export async function verifyCommandSource(
  remnote: RemNoteReader,
  source: CommandSource,
  rootRemId?: string,
): Promise<void> {
  let node = await remnote.read(source.documentRemId);
  if (node.remType !== "document") throw new Error("command source is no longer a Document");
  if (!rootRemId) return;
  const seen = new Set<string>();
  while (node.parentRemId && !seen.has(node.remId)) {
    if (node.parentRemId === rootRemId) return;
    seen.add(node.remId);
    node = await remnote.read(node.parentRemId);
  }
  throw new Error("command source is outside the configured maintenance root");
}

/** Both entry types use exactly the same export and task identities. */
export async function scanCommandSource(
  remnote: RemNoteReader,
  source: CommandSource,
  excluded: ReadonlySet<string>,
  progress: (count: number) => void = () => {},
): Promise<Awaited<ReturnType<typeof scanTodo>>> {
  const excludedIds = new Set(excluded);
  excludedIds.delete(source.documentRemId);
  for (const node of await allChildren(remnote, source.documentRemId))
    if (node.title.trim() === "已完成") excludedIds.add(node.remId);
  const scan = await scanTodo(remnote, source.documentRemId, progress, excludedIds, !!source.scope);
  const instructions = maintenanceInstructions(source);
  if (instructions) for (const task of scan.tasks) task.developerInstructions = instructions;
  return scan;
}

export async function ensureStartedBucket(remnote: RemNoteReader, task: TodoTask): Promise<void> {
  const matches = (await allChildren(remnote, task.documentRemId)).filter(
    (n) => n.title === "已开始",
  );
  if (matches.length > 1) throw new Error("document has multiple 已开始 buckets");
  if (matches.length) return;
  const id = await remnote.create(task.documentRemId, "已开始");
  const node = await remnote.read(id);
  if (node.title !== "已开始" || node.parentRemId !== task.documentRemId)
    throw new Error("started bucket readback mismatch");
}
