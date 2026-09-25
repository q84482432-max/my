/**
 * simtradeStage —— SIMTRADE 交易阶段判定（**唯一业务定义**）
 *
 * 为什么单独一层：
 *  阶段谓词（「当前能否下单」「当日收盘是否已揭示」）同时被**交易服务**
 *  （`services/simtradeService.ts`）与**只读 API**（`app/api/intraday/route.ts`）需要。
 *  - 放在 service 里 → 只读 API 为了一个布尔判断就要 import 整个会话写逻辑（含 prisma 写路径）；
 *  - 各自复制一份   → 产生两份会漂移的真相（2026-09-22 审计实测：确实存在两份实现）。
 *  因此收敛到这里：纯函数、零副作用、零依赖（只依赖 `@/types`）。
 *
 * 防泄漏红线：
 *  `isCloseRevealed` 是「当日 close 能否对外下发」的**唯一开关**。
 *  任何绕过它直接返回当日收盘/最高/最低的代码都属于未来数据泄漏，必须改回走本函数。
 *
 * 注意：本文件不判断「30m 第几根已揭示」这类**日内进度**语义 —— 那属于阶段推进的
 * 独立扩展（V3），不应与本文件的「阶段 → 是否揭示收盘」映射混淆。
 */

import type { SimTradeStage } from "@/types";

/** 允许下单的阶段（其余阶段一律拒绝） */
export const TRADABLE_STAGES: readonly SimTradeStage[] = ["OPEN", "CLOSE"];

/**
 * 已揭示「当日收盘价」的阶段 —— `CLOSE_ANIMATION` 起才允许对外返回当日 close。
 *
 * 与 V2 既有红线一致：未进入该集合前，当日 high/low/close 一律不得下发
 * （前端只能看到开盘信息）。
 */
export const CLOSE_REVEALED_STAGES: readonly SimTradeStage[] = [
  "CLOSE_ANIMATION",
  "CLOSE",
  "CLOSE_CONFIRMED",
  "DAY_SETTLED",
];

/** 当前阶段是否允许下单 */
export function isTradableStage(stage: SimTradeStage): boolean {
  return TRADABLE_STAGES.includes(stage);
}

/** 当前阶段是否已揭示当日收盘价（防泄漏红线：此前一律不得返回当日 close） */
export function isCloseRevealed(stage: SimTradeStage): boolean {
  return CLOSE_REVEALED_STAGES.includes(stage);
}
