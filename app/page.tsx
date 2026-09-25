import MarketHome from "@/components/MarketHome";
import IndexOverview from "@/components/IndexOverview";
import { listIndexQuotesSafe } from "@/lib/indexQuotes";

/**
 * 首页依赖数据库中的指数行情，必须动态渲染 ——
 * 否则 next build 时会把指数点位固化进静态产物，之后日更也看不到变化。
 */
export const dynamic = "force-dynamic";

/**
 * 首页（服务端组件）
 *
 * 结构：大盘概览（指数） + 行情中心（个股）。
 *
 * 指数行情在服务端取好直出，避免客户端二次请求造成的闪烁；
 * `listIndexQuotesSafe` 保证取数失败（如表未建/未导入）时返回空数组，
 * IndexOverview 会自行隐藏整块，下方个股行情照常渲染。
 */
export default async function Page() {
  const indexQuotes = await listIndexQuotesSafe();

  return (
    <div className="space-y-6">
      <IndexOverview quotes={indexQuotes} />
      <MarketHome />
    </div>
  );
}
