import { NextResponse } from "next/server";
import { submitSimTradeAction } from "@/services/simtradeService";
import type { SimTradeAction } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/action —— 提交「今日操作」
 *
 * body: { action: "BUY" | "SELL" | "HOLD", percent?: number, mode?: "INSTANT" | "CONFIRM" }
 *
 * V3 两种执行模式（**同一套交易规则，差别只在「何时执行」**）：
 *  - `INSTANT`（缺省）：服务端校验后**立即成交**；
 *  - `CONFIRM`：服务端先把请求**落库为待确认**（pending），再由
 *    `POST /api/simtrade/:id/confirm` 成交。落 pending 时**不消耗任何计数**。
 *
 * 关键防泄漏点：**成交日 & 行情可见上界由服务端强制为会话 currentDate**，
 * 客户端无法传入任何日期；**成交价也由服务端决定**（客户端传价无效）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      action?: SimTradeAction;
      percent?: number | string | null;
      mode?: string;
    };

    // JSON 表单/代理层有时会把数字序列化为字符串；只归一化有限数字字符串，
    // null、空字符串和非数字仍交给服务层按「比例必须显式且 1~100」拒绝。
    const percent =
      typeof body.percent === "string" && body.percent.trim() !== ""
        ? Number(body.percent)
        : body.percent;

    if (body.action !== "BUY" && body.action !== "SELL" && body.action !== "HOLD") {
      return NextResponse.json(
        { success: false, message: "操作类型必须为 BUY / SELL / HOLD" },
        { status: 400 },
      );
    }

    const result = await submitSimTradeAction(id, {
      action: body.action,
      percent: typeof percent === "number" ? percent : undefined,
      // 只接受 INSTANT / CONFIRM 两个已知值；其它（含缺省）交给服务层按默认处理
      mode:
        body.mode === "CONFIRM" ? "CONFIRM" : body.mode === "INSTANT" ? "INSTANT" : undefined,
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
