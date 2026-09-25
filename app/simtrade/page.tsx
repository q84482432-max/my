import SimTradeClient from "@/components/SimTradeClient";

export const metadata = {
  title: "模拟炒股 · 猜股票",
  description: "随机隐藏一只真实历史个股，只给K线和价格，凭盘感做多，与买入持有比收益",
};

/**
 * 强制动态渲染（与 /stocks、/sim、/backtest 等页面保持一致）。
 *
 * 为什么必须加：本页是纯客户端外壳，页面本身不依赖服务端数据，Next 会把它**预渲染成静态页**
 * 并附带 `Cache-Control: s-maxage=31536000`（实测：`x-nextjs-prerender: 1` +
 * `x-nextjs-cache: HIT`）。一旦有共享缓存/CDN 在前面，新版本部署后**旧 HTML 可能被长期
 * 缓存（最长一年）**，而旧 HTML 引用的 `.next/static` 指纹在部署时已被替换 →
 * 页面 JS/CSS 404、界面直接坏掉。
 *
 * 另一处细节：`/simtrade` 是唯一漏写本声明的页面，其余页面早已统一 `force-dynamic`；
 * 这次补齐属于消除不一致，而不是新增约定。
 */
export const dynamic = "force-dynamic";

/** 模拟炒股（猜股票）独立入口 —— 与 /backtest、/sim 并列 */
export default function Page() {
  return <SimTradeClient />;
}
