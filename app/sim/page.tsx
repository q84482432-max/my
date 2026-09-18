import SimulationClient from "@/components/SimulationClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "历史模拟交易 · A股模拟交易系统",
};

/**
 * 历史模拟交易页。
 *
 * 服务端只负责渲染外壳，全部数据通过 /api/sim/* 拉取 ——
 * 行情可见上界（currentDate）由服务端持久化并强制，前端无法提前读取未来行情。
 */
export default function SimPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">历史模拟交易</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          选择起止日期与初始资金，系统按真实历史交易日逐日推进。你只能看到当前模拟交易日
          及以前的行情；每推进一日会重新计算账户现金、持仓市值、总资产、每日盈亏、
          累计收益与最大回撤。
        </p>
      </div>
      <SimulationClient />
    </div>
  );
}
