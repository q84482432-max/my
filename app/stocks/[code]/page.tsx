import Link from "next/link";
import { notFound } from "next/navigation";
import { getStockInfo, getKlines, getStockQuote } from "@/services/marketDataService";
import type { KlineBar, KlinePeriod, StockQuote } from "@/types";
import StockDetail from "@/components/StockDetail";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ period?: string }>;
}

/**
 * 股票详情页（服务端组件）
 *
 * 职责：
 *  - 从 marketDataService 拉取股票信息、K线、最新行情（全部为真实历史数据）
 *  - 把纯 DTO 交给客户端组件 StockDetail 渲染与交互
 *  - 页面本身不包含任何交易逻辑
 */
export default async function StockDetailPage({ params, searchParams }: PageProps) {
  const { code } = await params;
  const sp = await searchParams;

  const periodParam = (sp.period ?? "1d") as KlinePeriod;
  const period: KlinePeriod = ["1d", "1w", "1M"].includes(periodParam) ? periodParam : "1d";

  // 股票不存在（或代码非法）→ 404
  const info = await getStockInfo(code);
  if (!info) notFound();

  // 复权口径以该股自身的数据口径为准（qfq 5430 只 / none 128 只），
  // 避免写死导致查不到数据。
  const [quote, bars] = await Promise.all([
    getStockQuote(code, info.adjust) as Promise<StockQuote | null>,
    getKlines(code, { period, adjust: info.adjust, limit: 2000 }) as Promise<
      KlineBar[]
    >,
  ]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <nav className="mb-4 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          行情中心
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">
          {info.name} {info.code}
        </span>
      </nav>

      <StockDetail
        stock={info}
        quote={quote}
        initialBars={bars}
        initialPeriod={period}
        initialBarCount={bars.length}
      />
    </div>
  );
}
