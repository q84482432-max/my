import SimTradeClient from "@/components/SimTradeClient";

export const metadata = {
  title: "模拟炒股 · 猜股票",
  description: "随机隐藏一只真实历史个股，只给K线和价格，凭盘感做多，与买入持有比收益",
};

/** 模拟炒股（猜股票）独立入口 —— 与 /backtest、/sim 并列 */
export default function Page() {
  return <SimTradeClient />;
}
