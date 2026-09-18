/**
 * 真实 A股日K JSON 数据导入器（第二阶段）
 *
 * ⚠️ 本脚本**只读**源数据目录，绝不写入 / 修改 / 移动任何原始文件。
 *
 * 数据源结构（由上游生成，本脚本仅消费）：
 *   <SRC>/full_market_index.json      全市场索引
 *   <SRC>/full_market_qfq/k_<code>.json    沪深主板（3192 只）
 *   <SRC>/full_market_extra/k_<code>.json  双创 + 北交所（2366 只）
 *
 * 索引顶层字段：
 *   generated / window / cut / warm_start / total / by_board /
 *   full_window_by_board / stocks
 *   stocks[code] = { name, board(中文), fq(qfq|raw), bars, start, end,
 *                    full_window, src(full_market_qfq|full_market_extra) }
 *
 * 行数据格式（两目录一致）：
 *   { d: "YYYYMMDD", o, c, h, l, v }    —— 无 amount 字段
 *
 * 字段适配决策（以真实数据为准）：
 *   d      → tradeDate（UTC 零点，避免时区漂移）
 *   o/c/h/l→ open/close/high/low（Decimal，保留三位小数精度）
 *   v      → volume（BigInt，单位：股）
 *   amount → **派生字段**：close × volume（源数据未提供成交额）
 *   fq     → adjust（qfq → "qfq"，raw → "none"），用于隔离两种口径
 *   board  → 中文板块名经 BOARD_CN_TO_ENUM 映射为内部英文枚举
 *   src    → sourceDir（记录来源，便于溯源与增量比对）
 *
 * 用法：
 *   # 先试跑（只解析不写库，校验完整性）
 *   npx tsx scripts/importMarketJson.ts --dry-run
 *
 *   # 正式全量导入（会先清空旧数据，默认口径不同需隔离）
 *   npx tsx scripts/importMarketJson.ts --replace
 *
 *   # 只导入指定代码
 *   npx tsx scripts/importMarketJson.ts --codes=600519,000001
 *
 * 参数：
 *   --src=<路径>        源目录，默认读取环境变量 MARKET_SOURCE_DIR
 *   --replace           导入前清空 stocks / klines（口径隔离，避免回测污染）
 *   --codes=a,b,c       仅导入指定代码
 *   --limit=N           仅导入前 N 只（调试）
 *   --batch=N           每批事务写入的股票数，默认 50
 *   --dry-run           只校验不写库
 *
 * 说明：
 *  - 幂等：同一 (stockId, period, tradeDate, adjust) 重复导入走 upsert。
 *  - 不生成任何 mock / 随机数据；源文件有多少条就导多少条。
 *  - 全程按股票分批事务，失败即中止并保留已完成批次。
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import prisma from "../lib/prisma";
import { BOARD_CN_TO_ENUM, SOURCE_FQ_TO_ADJUST } from "../lib/constants";

config();

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const item of argv) {
    const m = item.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] ?? "true";
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const SRC_DIR = path.resolve(
  args.src ||
    process.env.MARKET_SOURCE_DIR ||
    "C:/Users/Administrator.USER-20260201WA/WorkBuddy/2026-09-02-23-58-48/output",
);
const DRY_RUN = args["dry-run"] === "true";
const REPLACE = args.replace === "true";
const BATCH_SIZE = Number(args.batch || 50);
const LIMIT = args.limit ? Number(args.limit) : 0;
const ONLY_CODES = args.codes
  ? new Set(args.codes.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// ---------------------------------------------------------------- 类型定义

interface IndexMeta {
  name: string;
  board: string;
  fq: string;
  bars: number;
  start: string;
  end: string;
  full_window: boolean;
  src: string;
}

interface FullIndex {
  generated?: string;
  window?: string;
  cut?: string;
  warm_start?: string;
  total: number;
  by_board?: Record<string, number>;
  full_window_by_board?: Record<string, number>;
  stocks: Record<string, IndexMeta>;
}

interface RawRow {
  d: string;
  o: number;
  c: number;
  h: number;
  l: number;
  v: number;
}

interface StockFile {
  code: string;
  name: string;
  board?: string;
  fq?: string;
  bars?: number;
  start?: string;
  end?: string;
  full_window?: boolean;
  rows: RawRow[];
}

// ---------------------------------------------------------------- 工具函数

/** YYYYMMDD → UTC 零点 Date（与 marketDataService.normalizeDate 语义一致） */
function parseTradeDate(d: string): Date {
  if (!/^\d{8}$/.test(d)) throw new Error(`非法日期格式: ${d}`);
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new Error(`非法日历日期: ${d}`);
  }
  return dt;
}

/** 进度输出（节流，避免刷屏） */
let lastLog = 0;
function logProgress(msg: string, force = false) {
  const now = Date.now();
  if (force || now - lastLog > 800) {
    lastLog = now;
    process.stdout.write(msg + "\n");
  }
}

// ---------------------------------------------------------------- 主流程

interface ImportStats {
  stocks: number;
  bars: number;
  skipped: number;
  errors: string[];
  byBoard: Record<string, number>;
  byAdjust: Record<string, number>;
  minBars: number;
  maxBars: number;
}

async function main() {
  console.log("=".repeat(70));
  console.log("真实 A股日K JSON 导入器（第二阶段）");
  console.log("=".repeat(70));
  console.log(`源目录   : ${SRC_DIR}`);
  console.log(`模式     : ${DRY_RUN ? "DRY-RUN（仅校验，不写库）" : "正式导入"}`);
  console.log(`清空旧数据: ${REPLACE ? "是" : "否"}`);
  console.log(`批大小   : ${BATCH_SIZE}`);
  if (ONLY_CODES) console.log(`指定代码 : ${[...ONLY_CODES].join(",")}`);
  if (LIMIT) console.log(`限制数量 : ${LIMIT}`);
  console.log("");

  // --- 1. 读取索引 ---
  const indexPath = path.join(SRC_DIR, "full_market_index.json");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`索引文件不存在: ${indexPath}`);
  }
  const index: FullIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  const allCodes = Object.keys(index.stocks);
  console.log(`索引读取完成: ${allCodes.length} 只（索引声明 total=${index.total}）`);
  console.log(`窗口: ${index.window}  warm_start=${index.warm_start}  cut=${index.cut}`);
  console.log(`板块分布: ${JSON.stringify(index.by_board)}`);
  console.log("");

  // --- 2. 构造待导入清单 ---
  let codes = allCodes;
  if (ONLY_CODES) codes = codes.filter((c) => ONLY_CODES.has(c));
  if (LIMIT > 0) codes = codes.slice(0, LIMIT);
  console.log(`待导入: ${codes.length} 只`);
  console.log("");

  // --- 3. 清空旧数据（可选） ---
  if (REPLACE && !DRY_RUN) {
    console.log("清空旧数据（stocks / klines）...");
    // klines 通过 Stock 级联删除会有外键顺序问题，显式分开删更稳
    const delK = await prisma.kline.deleteMany({});
    const delS = await prisma.stock.deleteMany({});
    console.log(`  已删除 klines: ${delK.count} 行, stocks: ${delS.count} 行`);
    console.log("");
  }

  const stats: ImportStats = {
    stocks: 0,
    bars: 0,
    skipped: 0,
    errors: [],
    byBoard: {},
    byAdjust: {},
    minBars: Number.POSITIVE_INFINITY,
    maxBars: 0,
  };

  const startedAt = Date.now();
  let processed = 0;

  // --- 4. 分批处理 ---
  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batchCodes = codes.slice(i, i + BATCH_SIZE);

    // 4.1 先把本批所有股票的数据文件读进来并校验（读盘在事务外，缩短事务时间）
    const prepared: Array<{
      code: string;
      name: string;
      exchange: string;
      board: string;
      adjust: string;
      sourceDir: string;
      fullWindow: boolean;
      barCount: number;
      windowStart: Date;
      windowEnd: Date;
      bars: Array<{
        tradeDate: Date;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: bigint;
        amount: number;
      }>;
    }> = [];

    for (const code of batchCodes) {
      const meta = index.stocks[code];
      if (!meta) {
        stats.skipped++;
        stats.errors.push(`${code}: 索引中缺失元数据`);
        continue;
      }

      const filePath = path.join(SRC_DIR, meta.src, `k_${code}.json`);
      if (!fs.existsSync(filePath)) {
        stats.skipped++;
        stats.errors.push(`${code}: 数据文件不存在 (${meta.src})`);
        continue;
      }

      let file: StockFile;
      try {
        file = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch (e) {
        stats.skipped++;
        stats.errors.push(`${code}: JSON 解析失败 - ${(e as Error).message}`);
        continue;
      }

      const rows = file.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        stats.skipped++;
        stats.errors.push(`${code}: rows 为空`);
        continue;
      }

      // 板块 / 交易所映射（以索引中文板块为准，代码前缀兜底）
      const mapped = BOARD_CN_TO_ENUM[meta.board];
      if (!mapped) {
        stats.skipped++;
        stats.errors.push(`${code}: 未知板块 "${meta.board}"`);
        continue;
      }

      // 复权口径映射：qfq → "qfq"，raw → "none"
      const adjust = SOURCE_FQ_TO_ADJUST[meta.fq];
      if (!adjust) {
        stats.skipped++;
        stats.errors.push(`${code}: 未知复权标记 "${meta.fq}"`);
        continue;
      }

      // 逐行转换 + 完整性校验
      const bars = new Array(rows.length);
      let badRows = 0;
      const seenDates = new Set<string>();
      let dupDate = false;
      let prevKey = "";

      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        let tradeDate: Date;
        try {
          tradeDate = parseTradeDate(row.d);
        } catch (e) {
          badRows++;
          continue;
        }

        if (seenDates.has(row.d)) dupDate = true;
        seenDates.add(row.d);

        // 越界与异常值校验（发现即记录，不静默吞掉）
        if (
          !Number.isFinite(row.o) ||
          !Number.isFinite(row.c) ||
          !Number.isFinite(row.h) ||
          !Number.isFinite(row.l) ||
          !Number.isFinite(row.v)
        ) {
          badRows++;
          continue;
        }
        if (row.o <= 0 || row.c <= 0 || row.h <= 0 || row.l <= 0) {
          badRows++;
          continue;
        }

        const close = row.c;
        const volume = BigInt(Math.round(row.v));
        bars[r] = {
          tradeDate,
          open: row.o,
          high: row.h,
          low: row.l,
          close,
          volume,
          // 源数据无 amount，按 收盘价 × 成交量 派生
          amount: close * Number(volume),
        };
        prevKey = row.d;
      }

      if (badRows > 0) {
        stats.errors.push(`${code}: ${badRows} 行数据异常被跳过`);
      }
      if (dupDate) {
        stats.errors.push(`${code}: 存在重复交易日`);
      }

      const clean = bars.filter(Boolean);
      if (clean.length === 0) {
        stats.skipped++;
        stats.errors.push(`${code}: 全部行无效`);
        continue;
      }
      void prevKey;

      // bars 数量与索引声明不一致时告警（不阻断，属上游裁剪结果）
      if (meta.bars !== clean.length) {
        stats.errors.push(
          `${code}: 根数不一致 索引=${meta.bars} 实际=${clean.length}`,
        );
      }

      const windowStart = clean[0].tradeDate;
      const windowEnd = clean[clean.length - 1].tradeDate;

      prepared.push({
        code,
        name: file.name || meta.name,
        exchange: mapped.exchange,
        board: mapped.board,
        adjust,
        sourceDir: meta.src,
        fullWindow: meta.full_window,
        barCount: clean.length,
        windowStart,
        windowEnd,
        bars: clean,
      });

      stats.minBars = Math.min(stats.minBars, clean.length);
      stats.maxBars = Math.max(stats.maxBars, clean.length);
    }

    if (prepared.length === 0) continue;

    // 4.2 单事务写库
    if (!DRY_RUN) {
      await prisma.$transaction(
        async (tx) => {
          for (const p of prepared) {
            const stock = await tx.stock.upsert({
              where: { code: p.code },
              create: {
                code: p.code,
                name: p.name,
                exchange: p.exchange,
                board: p.board,
                adjust: p.adjust,
                fullWindow: p.fullWindow,
                sourceDir: p.sourceDir,
                barCount: p.barCount,
                windowStart: p.windowStart,
                windowEnd: p.windowEnd,
                isActive: true,
              },
              update: {
                name: p.name,
                exchange: p.exchange,
                board: p.board,
                adjust: p.adjust,
                fullWindow: p.fullWindow,
                sourceDir: p.sourceDir,
                barCount: p.barCount,
                windowStart: p.windowStart,
                windowEnd: p.windowEnd,
              },
            });

            // 该股已有数据先清理（--replace 之外的重复导入也保证幂等一致）
            await tx.kline.deleteMany({ where: { stockId: stock.id } });

            // createMany 批量插入（比逐条 upsert 快一个数量级）
            const CHUNK = 500;
            for (let c = 0; c < p.bars.length; c += CHUNK) {
              await tx.kline.createMany({
                data: p.bars.slice(c, c + CHUNK).map((b) => ({
                  stockId: stock.id,
                  period: "1d",
                  tradeDate: b.tradeDate,
                  open: b.open,
                  high: b.high,
                  low: b.low,
                  close: b.close,
                  volume: b.volume,
                  amount: b.amount,
                  adjust: p.adjust,
                })),
              });
            }
          }
        },
        { timeout: 120_000, maxWait: 20_000 },
      );
    }

    for (const p of prepared) {
      stats.stocks++;
      stats.bars += p.bars.length;
      stats.byBoard[p.board] = (stats.byBoard[p.board] || 0) + 1;
      stats.byAdjust[p.adjust] = (stats.byAdjust[p.adjust] || 0) + 1;
    }

    processed += batchCodes.length;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    logProgress(
      `  进度 ${processed}/${codes.length} 只  |  已写 ${stats.bars} 根  |  ${elapsed}s`,
    );
  }

  // ---------------------------------------------------------------- 汇总
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log("=".repeat(70));
  console.log("导入完成");
  console.log("=".repeat(70));
  console.log(`股票数   : ${stats.stocks}`);
  console.log(`K线根数  : ${stats.bars}`);
  console.log(`跳过     : ${stats.skipped}`);
  console.log(`板块分布 : ${JSON.stringify(stats.byBoard)}`);
  console.log(`口径分布 : ${JSON.stringify(stats.byAdjust)}`);
  console.log(
    `根数范围 : ${stats.minBars === Number.POSITIVE_INFINITY ? "-" : stats.minBars} ~ ${stats.maxBars}`,
  );
  console.log(`耗时     : ${totalSec}s`);

  if (stats.errors.length > 0) {
    console.log("");
    console.log(`异常记录（${stats.errors.length} 条，最多展示 30 条）：`);
    stats.errors.slice(0, 30).forEach((e) => console.log("  - " + e));
    if (stats.errors.length > 30) {
      console.log(`  ... 其余 ${stats.errors.length - 30} 条省略`);
    }
  }

  if (DRY_RUN) {
    console.log("");
    console.log("（DRY-RUN 未写入数据库；去掉 --dry-run 即可正式导入）");
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\n导入失败：", e);
    await prisma.$disconnect();
    process.exit(1);
  });
