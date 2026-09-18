import { NextResponse } from "next/server";
import { listBacktests, runAndSaveBacktest } from "@/services/backtestService";
import type { BacktestInput } from "@/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/backtest —— 回测历史（按创建时间倒序，不含大数组）
 */
export async function GET() {
  try {
    const items = await listBacktests();
    return NextResponse.json({ success: true, data: items, count: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/backtest —— 运行一次策略回测并落库
 *
 * body: {
 *   symbol: string,            股票代码（必填）
 *   startDate: "YYYY-MM-DD",
 *   endDate:   "YYYY-MM-DD",
 *   initialCash: number,
 *   strategy?: "MA_CROSS",     第一批仅均线金叉死叉
 *   params?: { fast?: number, slow?: number },   默认 5 / 20
 *   name?: string
 * }
 *
 * 回测为**纯内存计算**：只读 klines/stocks，不写 Account / Position /
 * Order / Trade / DailyAsset 任何一张表；结果单独落在 Backtest 表。
 * 成交模型为「信号 T 日收盘产生 → T+1 日开盘成交」，不含未来函数。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<BacktestInput> & {
      name?: string;
    };

    const result = await runAndSaveBacktest({
      symbol: String(body.symbol ?? "").trim(),
      startDate: String(body.startDate ?? "").slice(0, 10),
      endDate: String(body.endDate ?? "").slice(0, 10),
      initialCash: Number(body.initialCash ?? 100_000),
      strategy: body.strategy ?? "MA_CROSS",
      params: body.params,
      name: body.name,
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
