import type { StatusLineSources, RunningItem } from "./statusline.js";
import { ledgerRunningItems, taskboardRunningItems } from "./statusline.js";

/**
 * v0.4.1 会话透明度补全：agent_turn_prepare 每回合注入后台任务清单。
 * - 无任务时不注入（零 token 开销）
 * - 有任务时注入简短清单（appendContext，追加到回合上下文尾部）
 * - 数据源与状态行同源：SQLite 台账（pid 存活校验）+ taskboard.md 进行中段
 */

export interface TurnPrepareSources extends StatusLineSources {
  /** 注入清单最大条目数（默认 5） */
  maxItems?: number;
}

function formatTurnItems(items: RunningItem[], maxItems: number): string {
  const shown = items
    .slice(0, maxItems)
    .map((i) => (i.detail ? `- ${i.name}（${i.detail}）` : `- ${i.name}`));
  const more = items.length > maxItems ? `\n- …等共 ${items.length} 个` : "";
  return shown.join("\n") + more;
}

/**
 * 生成回合注入文本；无任务返回 undefined（调用方不注入）。
 */
export function buildTurnContext(sources: TurnPrepareSources): string | undefined {
  const items = [
    ...ledgerRunningItems(sources),
    ...taskboardRunningItems(sources.taskboardFile),
  ];
  if (items.length === 0) return undefined;
  const maxItems = sources.maxItems ?? 5;
  const body = formatTurnItems(items, maxItems);
  return [
    `[harness-bridge] 当前后台任务 ${items.length} 个：`,
    body,
    "（完成情况用 harness_status 查询；不要向用户重复本清单，除非用户问起）",
  ].join("\n");
}
