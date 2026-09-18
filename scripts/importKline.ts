/**
 * 【已弃用 · 保留备查】第一阶段 CSV 行情导入器
 *
 * ⚠️ 请勿用于当前数据库。第二阶段已改用 JSON 导入器：
 *      scripts/importMarketJson.ts   （npm run import:market / npm run import:dry）
 *      数据源：{...}/output/full_market_index.json + full_market_qfq|extra/k_<code>.json
 *
 * 保留原因：第一阶段 CSV 源的导入逻辑留档。当前库内为第二阶段 JSON 全量数据
 * （5558 只 / 2,346,677 根，默认口径 qfq），本脚本未挂载到 package.json。
 * 为避免误跑以错误口径覆写 K 线，本脚本现要求必须显式传 --adjust。
 *
 * ---------------------------------------------------------------------------
 * 行情数据导入器
 *
 * 用途：把**真实** A股日K 数据导入数据库。
 *
 * 本项目的真实数据来自通达信导出，目录结构为：
 *   data/kline/{代码}.{setcode}.day.csv     —— 每只股票一个文件
 *   data/universe.csv                        —— 全市场股票池（代码,名称,market,setcode）
 *
 * CSV 列（固定表头）：
 *   Data,Open,High,Low,Close,Volume,Amount,Exchange
 *   其中 Exchange 列为「换手率(%)」，本系统未建模，导入时忽略。
 *   ⚠️ 该 CSV 为**不复权原始行情**（经平安银行 2025-06-03 除权窗口校验：
 *      10.60→10.85 无跳空调整），故使用时须传 --adjust=none。
 *
 * 用法：
 *   # 推荐：批量导入整个目录（自动读取同级 universe.csv 补全名称与市场）
 *   npx tsx scripts/importKline.ts --dir=./data/kline --setcode-from-filename --name-map=./data/universe.csv --adjust=none
 *
 *   # 导入单个文件
 *   npx tsx scripts/importKline.ts --file=./data/kline/600519.1.day.csv --code=600519 --name=贵州茅台 --setcode=1 --adjust=none
 *
 * 其他参数：
 *   --adjust=qfq|hfq|none   【必填】复权口径。第一阶段 CSV 源为不复权，应传 none。
 *   --replace=true          导入前清空该股票已有日K（数据源切换时使用）
 *   --skip-missing-market   跳过不在 universe 中的标的（如指数 000300）
 *
 * 说明：
 *  - 重复导入幂等（upsert），可安全重跑。
 *  - 不做任何随机数据生成：文件里有多少就导多少。
 *  - setcode 优先于代码前缀推断交易所，可正确处理 000300(沪) vs 000001(深)。
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import {
  clearKlines,
  ensureStock,
  upsertKlines,
} from "../services/marketDataService";
import { resolveExchangeAndBoard } from "../lib/utils";
import type { AdjustType, KlineBar } from "../types";

config();

/** 解析命令行参数 */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const item of argv) {
    const m = item.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] ?? "true";
  }
  return args;
}

/** 中文/英文表头统一映射（兼容本数据源 Data/Open/... 与常见中文导出） */
const HEADER_MAP: Record<string, string> = {
  date: "date",
  日期: "date",
  data: "date", // 本数据源使用 Data 列名
  时间: "date",
  trade_date: "date",
  open: "open",
  开盘: "open",
  开盘价: "open",
  high: "high",
  最高: "high",
  最高价: "high",
  low: "low",
  最低: "low",
  最低价: "low",
  close: "close",
  收盘: "close",
  收盘价: "close",
  volume: "volume",
  成交量: "volume",
  vol: "volume",
  amount: "amount",
  成交额: "amount",
  成交金额: "amount",
};
// 注：Exchange 列（换手率）本系统未建模，不映射即自动忽略

/** 归一化日期字符串为 YYYY-MM-DD */
function normalizeDateStr(raw: string): string | null {
  const s = raw.trim().replace(/["']/g, "").replace(/^\ufeff/, "");
  if (!s) return null;
  // YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  // 带时间的 ISO
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function toNum(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const v = parseFloat(String(raw).replace(/[",%]/g, ""));
  return Number.isFinite(v) ? v : 0;
}

/** 解析 CSV -> KlineBar[] */
export function parseCsv(content: string): KlineBar[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  // 去除 UTF-8 BOM，避免首列表头识别失败
  const headerLine = lines[0].replace(/^\ufeff/, "");
  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP[h];
    if (key && idx[key] === undefined) idx[key] = i;
  });

  if (idx.date === undefined || idx.close === undefined) {
    throw new Error(
      `CSV 表头无法识别。需要至少包含 date/日期/Data 与 close/收盘 列。实际表头: ${headers.join(", ")}`,
    );
  }

  const bars: KlineBar[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",");
    const date = normalizeDateStr(cols[idx.date] ?? "");
    if (!date) continue;
    const close = toNum(cols[idx.close]);
    if (close <= 0) continue;
    const open = idx.open !== undefined ? toNum(cols[idx.open]) || close : close;
    const high = idx.high !== undefined ? toNum(cols[idx.high]) || close : close;
    const low = idx.low !== undefined ? toNum(cols[idx.low]) || close : close;
    bars.push({
      date,
      open,
      high: high || Math.max(open, close),
      low: low || Math.min(open, close),
      close,
      volume: idx.volume !== undefined ? toNum(cols[idx.volume]) : 0,
      amount: idx.amount !== undefined ? toNum(cols[idx.amount]) : 0,
    });
  }
  return bars;
}

/** 解析 JSON -> KlineBar[] */
export function parseJson(content: string): {
  bars: KlineBar[];
  name?: string;
  code?: string;
} {
  const raw = JSON.parse(content) as unknown;

  // 形式 A: { code, name, klines: [...] }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const list = (obj.klines ?? obj.data ?? obj.bars) as unknown[];
    if (Array.isArray(list)) {
      return {
        bars: normalizeJsonBars(list),
        name: typeof obj.name === "string" ? obj.name : undefined,
        code: typeof obj.code === "string" ? obj.code : undefined,
      };
    }
  }
  // 形式 B: 纯数组
  if (Array.isArray(raw)) {
    return { bars: normalizeJsonBars(raw) };
  }
  throw new Error("JSON 格式无法识别，需为数组或 { code, name, klines } 结构");
}

function normalizeJsonBars(list: unknown[]): KlineBar[] {
  const bars: KlineBar[] = [];
  for (const item of list) {
    const o = item as Record<string, unknown>;
    if (!o || typeof o !== "object") continue;
    const rawDate =
      (o.date as string) ??
      (o.day as string) ??
      (o.tradeDate as string) ??
      (o.日期 as string) ??
      "";
    const date = normalizeDateStr(String(rawDate));
    if (!date) continue;
    const close = toNum(String(o.close ?? o.收盘 ?? 0));
    if (close <= 0) continue;
    bars.push({
      date,
      open: toNum(String(o.open ?? o.开盘 ?? close)),
      high: toNum(String(o.high ?? o.最高 ?? close)),
      low: toNum(String(o.low ?? o.最低 ?? close)),
      close,
      volume: toNum(String(o.volume ?? o.成交量 ?? 0)),
      amount: toNum(String(o.amount ?? o.成交额 ?? 0)),
    });
  }
  return bars;
}

/** universe.csv 行结构 */
interface UniverseEntry {
  code: string;
  name: string;
  setcode: string;
}

/**
 * 读取 universe.csv（表头 sec_code,sec_name,market,setcode）。
 * 用于补全股票名称与权威市场归属。
 */
function loadUniverse(file: string): Map<string, UniverseEntry> {
  const map = new Map<string, UniverseEntry>();
  if (!fs.existsSync(file)) {
    console.warn(`[警告] universe 文件不存在，将回退到文件名/代码前缀推断: ${file}`);
    return map;
  }
  const content = fs.readFileSync(file, "utf-8").replace(/^\ufeff/, "");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // 表头定位（兼容列顺序变化）
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const iCode = headers.indexOf("sec_code");
  const iName = headers.indexOf("sec_name");
  const iSet = headers.indexOf("setcode");
  const iMarket = headers.indexOf("market");

  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",");
    const code = (iCode >= 0 ? cols[iCode] : cols[0])?.trim();
    if (!code) continue;
    const name = (iName >= 0 ? cols[iName] : cols[1])?.trim() ?? "";
    const setcode =
      (iSet >= 0 ? cols[iSet]?.trim() : undefined) ??
      (iMarket >= 0 ? cols[iMarket]?.trim() : undefined) ??
      "";
    map.set(code, { code, name, setcode });
  }
  return map;
}

/**
 * 从 `{code}.{setcode}.day.csv` 文件名解析代码与 setcode。
 * 兼容无 setcode 的 `{code}.csv` 形式（此时 setcode 为空，回退前缀推断）。
 */
function parseKlineFilename(file: string): { code: string; setcode: string | null } {
  const base = path.basename(file, path.extname(file));
  // 形如 000001.0.day / 600519.1.day / 920000.2.day
  const m = base.match(/^(\d{6})\.(\d)\./);
  if (m) return { code: m[1], setcode: m[2] };
  // 形如 000001.day / 600519
  const m2 = base.match(/(\d{6})/);
  if (m2) return { code: m2[1], setcode: null };
  return { code: base, setcode: null };
}

interface ImportStats {
  ok: number;
  skipped: number;
  failed: number;
  bars: number;
}

/** 导入单个文件 */
async function importFile(
  file: string,
  opts: {
    code?: string;
    name?: string;
    setcode?: string | null;
    adjust?: AdjustType;
    replace?: boolean;
    universe?: Map<string, UniverseEntry>;
    skipMissingMarket?: boolean;
  },
): Promise<{ status: "ok" | "skipped" | "failed"; bars: number; message: string }> {
  const content = fs.readFileSync(file, "utf-8");
  const ext = path.extname(file).toLowerCase();

  let bars: KlineBar[] = [];
  let name = opts.name;
  let code = opts.code;
  let setcode = opts.setcode ?? null;

  if (ext === ".csv" || ext === ".txt") {
    // 文件名优先提供 code / setcode（本数据源权威来源）
    const parsed = parseKlineFilename(file);
    code = code ?? parsed.code;
    setcode = setcode ?? parsed.setcode;
    bars = parseCsv(content);
  } else if (ext === ".json") {
    const parsed = parseJson(content);
    bars = parsed.bars;
    name = name ?? parsed.name;
    code = code ?? parsed.code;
  } else {
    return { status: "failed", bars: 0, message: `不支持的文件类型: ${ext}` };
  }

  if (!code) {
    return { status: "failed", bars: 0, message: "无法确定股票代码" };
  }

  // 用 universe.csv 补全名称与权威 setcode
  const uni = opts.universe?.get(code);
  if (uni) {
    name = name ?? uni.name;
    if (!setcode && uni.setcode) setcode = uni.setcode;
  } else if (opts.skipMissingMarket && opts.universe && opts.universe.size > 0) {
    // 不在股票池中的标的（如指数 000300）跳过，避免污染个股表
    return {
      status: "skipped",
      bars: 0,
      message: `不在 universe 股票池中（疑似指数/非个股），已跳过`,
    };
  }

  if (bars.length === 0) {
    return { status: "skipped", bars: 0, message: "未解析到有效数据" };
  }

  // 按日期升序 + 去重（同日期保留最后一条）
  const map = new Map<string, KlineBar>();
  for (const b of bars) map.set(b.date, b);
  const sorted = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));

  await ensureStock({ code, name, setcode });
  if (opts.replace) await clearKlines(code, "1d", opts.adjust ?? "none");

  const n = await upsertKlines(code, sorted, {
    period: "1d",
    adjust: opts.adjust ?? "none",
    setcode,
    name,
  });

  const { exchange, board } = resolveExchangeAndBoard(code, setcode);
  return {
    status: "ok",
    bars: n,
    message:
      `${code} ${name ?? ""} [setcode=${setcode ?? "-"} → ${exchange}/${board}] ` +
      `${sorted[0].date} ~ ${sorted[sorted.length - 1].date} 共 ${n} 根日K`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ── 口径防御闸（第二阶段新增） ──────────────────────────────────
  // 本导入器面向第一阶段的 CSV 源（原始不复权行情），已被 JSON 导入器
  // （scripts/importMarketJson.ts）取代，不再挂载到 package.json。
  // 当前库内数据以 qfq 为默认口径（DEFAULT_ADJUST）；若此脚本在未显式声明
  // 口径的情况下被误跑，会以 "none" 覆写已有 K 线，造成复权口径混存、
  // 回测结果失真。故要求必须显式传 --adjust 才允许执行。
  if (!args.adjust) {
    console.error(
      "\n[中止] 未显式指定复权口径。\n" +
        "  本导入器已由 scripts/importMarketJson.ts 取代（真实数据以 qfq 为主）。\n" +
        "  如确需使用，请显式声明： --adjust=none   （第一阶段 CSV 源为不复权）\n" +
        "  或                     --adjust=qfq\n" +
        "  可用脚本： npm run import:market  /  npm run import:dry\n"
    );
    process.exit(1);
  }

  const adjust = args.adjust as AdjustType;
  const stats: ImportStats = { ok: 0, skipped: 0, failed: 0, bars: 0 };
  const failures: { file: string; reason: string }[] = [];

  // 加载 universe（默认取数据目录同级的 universe.csv）
  let universe: Map<string, UniverseEntry> | undefined;
  const nameMapPath = args["name-map"]
    ? path.resolve(args["name-map"])
    : args.dir
      ? path.resolve(args.dir, "..", "universe.csv")
      : undefined;
  if (nameMapPath) {
    universe = loadUniverse(nameMapPath);
    console.log(`[股票池] 载入 ${universe.size} 只股票 (${nameMapPath})`);
  }

  if (args.file) {
    const r = await importFile(path.resolve(args.file), {
      code: args.code,
      name: args.name,
      setcode: args.setcode ?? null,
      adjust,
      replace: args.replace === "true",
      universe,
      skipMissingMarket: args["skip-missing-market"] === "true",
    });
    if (r.status === "ok") {
      stats.ok += 1;
      stats.bars += r.bars;
      console.log(`[导入] ${r.message}`);
    } else if (r.status === "skipped") {
      stats.skipped += 1;
      console.log(`[跳过] ${path.basename(args.file)} ${r.message}`);
    } else {
      stats.failed += 1;
      console.error(`[失败] ${path.basename(args.file)} ${r.message}`);
    }
    report(stats, failures);
    return;
  }

  if (args.dir) {
    const dir = path.resolve(args.dir);
    if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(csv|json)$/i.test(f))
      .sort();
    if (files.length === 0) {
      console.warn(`[提示] 目录 ${dir} 下没有 .csv/.json 文件`);
      return;
    }
    console.log(`[开始] 发现 ${files.length} 个数据文件，开始导入...`);
    const t0 = Date.now();

    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      try {
        const r = await importFile(path.join(dir, f), {
          adjust,
          replace: args.replace === "true",
          universe,
          skipMissingMarket: args["skip-missing-market"] === "true",
        });
        if (r.status === "ok") {
          stats.ok += 1;
          stats.bars += r.bars;
        } else if (r.status === "skipped") {
          stats.skipped += 1;
          failures.push({ file: f, reason: `跳过: ${r.message}` });
        } else {
          stats.failed += 1;
          failures.push({ file: f, reason: r.message });
        }
      } catch (err) {
        stats.failed += 1;
        failures.push({ file: f, reason: (err as Error).message });
      }
      // 进度输出：每 100 个文件报一次
      if ((i + 1) % 100 === 0 || i === files.length - 1) {
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `[进度] ${i + 1}/${files.length}  成功 ${stats.ok} 跳过 ${stats.skipped} 失败 ${stats.failed}  K线 ${stats.bars}  用时 ${sec}s`,
        );
      }
    }
    report(stats, failures);
    return;
  }

  console.log(
    [
      "用法：",
      "  # 批量导入（推荐）",
      "  npx tsx scripts/importKline.ts --dir=./data/kline --skip-missing-market=true",
      "",
      "  # 导入单只股票",
      "  npx tsx scripts/importKline.ts --file=./data/kline/600519.1.day.csv --code=600519 --name=贵州茅台 --setcode=1",
      "",
      "可选参数：",
      "  --adjust=qfq|hfq|none     复权口径【必填】。第一阶段 CSV 源为不复权，应传 none",
      "  --replace=true            导入前清空该股票已有日K",
      "  --name-map=./data/universe.csv   股票池文件（补全名称与市场）",
      "  --skip-missing-market=true       跳过不在股票池的标的（指数等）",
    ].join("\n"),
  );
}

function report(stats: ImportStats, failures: { file: string; reason: string }[]): void {
  console.log("");
  console.log("========== 导入结果 ==========");
  console.log(`成功 ${stats.ok} 个文件，共写入 ${stats.bars} 根日K`);
  console.log(`跳过 ${stats.skipped} 个，失败 ${stats.failed} 个`);
  if (failures.length > 0) {
    console.log("--- 跳过/失败明细（最多 20 条）---");
    for (const f of failures.slice(0, 20)) {
      console.log(`  ${f.file}: ${f.reason}`);
    }
    if (failures.length > 20) {
      console.log(`  ... 其余 ${failures.length - 20} 条省略`);
    }
  }
  console.log("==============================");
}

main()
  .catch((err) => {
    console.error("[错误]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 让 Prisma 连接正常退出
    const { default: prismaInstance } = await import("../lib/prisma");
    await prismaInstance.$disconnect();
  });
