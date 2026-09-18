import BacktestClient from "@/components/BacktestClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "策略回测 · A股模拟交易系统",
};

/**
 * 策略回测页。
 *
 * 与模拟交易系统完全隔离：BacktestEngine 只读真实历史日K、在内存中按时间
 * 顺序逐根推演，不写 Account / Position / Order / Trade / DailyAsset 任何一表。
 * 执行模型为「信号 T 日收盘产生 → T+1 日开盘成交」，杜绝未来函数。
 */
export default function BacktestPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">策略回测</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          输入股票、起止日期、初始资金与策略参数，用真实历史日K 按时间顺序回测。
          第一批支持 MA 快慢线金叉 / 死叉：金叉次日开盘买入，死叉次日开盘卖出。
          输出总收益率、年化收益率、最大回撤、交易次数、胜率、平均盈利、平均亏损、
          盈亏比、夏普比率，以及资金曲线、回撤曲线、买卖点与交易明细。
        </p>
      </div>
      <BacktestClient />
    </div>
  );
}
