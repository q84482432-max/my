/**
 * 指数行情批量读取 —— 读取层便利函数。
 *
 * 为什么单独放这里，而不是加进 services/indexDataService.ts
 * -------------------------------------------------------
 * `indexDataService` 是「指数读写的唯一入口」，它既有的单只取数契约已被
 * `test:index`（46 项断言）覆盖。批量取行情只是把同一个单只函数循环调用，
 * 属于**调用侧编排**，放在 lib 层可以不动数据层的既有契约。
 *
 * 为什么不做成一条 SQL
 * -------------------
 * 指数总共 9 个，逐个取（各 2 条查询）在 SQLite 上是毫秒级；
 * 改成 JOIN + 窗口函数会更难读、更难维护，收益不成比例。
 */
import { getIndexQuote, listIndices } from "@/services/indexDataService";
import type { IndexInfo } from "@/types";

/** 指数元信息 + 最新行情（服务端与客户端共用的展示 DTO） */
export interface IndexQuoteItem extends IndexInfo {
  /** 最新收盘点位 */
  lastPrice: number;
  /** 涨跌点数 */
  change: number;
  /** 涨跌幅 % */
  changePercent: number;
  /** 上一交易日收盘点位 */
  prevClose: number;
  /** 最新交易日 YYYY-MM-DD */
  lastDate: string;
}

/**
 * 取全部指数的最新行情（按代码升序，与 listIndices 一致）。
 *
 * 单只取数失败（例如该指数暂无 K 线）会被**跳过**而不是让整个列表失败 ——
 * 首页与指数页都是展示场景，一个指数缺数据不该导致整页空白。
 */
export async function listIndexQuotes(): Promise<IndexQuoteItem[]> {
  const indices = await listIndices();
  const settled = await Promise.all(
    indices.map((i) => getIndexQuote(i.code).catch(() => null)),
  );
  return settled.filter((q): q is IndexQuoteItem => q !== null);
}

/**
 * 取全部指数行情，且**永不抛错**（失败时返回空数组）。
 *
 * 给首页用：指数是首页的附加信息，指数表尚未建/未导入数据时，
 * 首页其余部分必须照常渲染。
 */
export async function listIndexQuotesSafe(): Promise<IndexQuoteItem[]> {
  try {
    return await listIndexQuotes();
  } catch {
    return [];
  }
}
