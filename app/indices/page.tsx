import Link from "next/link";
import { getIndexKlines, listIndices } from "@/services/indexDataService";
import { listIndexQuotesSafe } from "@/lib/indexQuotes";
import IndexBoard from "@/components/IndexBoard";
import type { IndexBar } from "@/types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ code?: string }>;
}

/** 默认展示上证指数（大盘基准） */
const DEFAULT_CODE = "sh000001";

/**
 * 指数页（服务端组件）
 *
 * 职责：
 *  - 指数清单、各指数最新行情、以及**选中指数**的日K 全部在服务端取好，
 *    首屏直出（无需客户端二次请求）；
 *  - 交给客户端组件 IndexBoard 负责选择切换与图表渲染；
 *  - 本页只读 market_indices / index_klines，不涉及任何个股数据。
 *
 * 选中逻辑：URL 的 `?code=` 优先，但**必须真实存在**才采纳；
 * 否则依次回退到上证指数、清单第一项。这样手改 URL 传脏值不会白屏。
 */
export default async function IndicesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const requested = (sp.code ?? "").trim().toLowerCase();

  const [indices, quotes] = await Promise.all([
    listIndices(),
    listIndexQuotesSafe(),
  ]);

  const selectedCode =
    (requested && indices.some((i) => i.code === requested) ? requested : "") ||
    (indices.some((i) => i.code === DEFAULT_CODE) ? DEFAULT_CODE : "") ||
    indices[0]?.code ||
    null;

  // 只取最近 2000 根：足够覆盖约 8 年日线，避免把 5000 根全塞进首屏
  const bars: IndexBar[] = selectedCode
    ? await getIndexKlines(selectedCode, { limit: 2000 })
    : [];

  return (
    <div className="space-y-5">
      <nav className="text-sm text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-foreground">
          行情中心
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">指数</span>
      </nav>

      <IndexBoard
        indices={indices}
        quotes={quotes}
        selectedCode={selectedCode}
        bars={bars}
      />
    </div>
  );
}
