# -*- coding: utf-8 -*-
"""
SIMTRADE V3 —— A 股 30 分钟 K 全量下载器（v2，正式）

═══════════════════════════════════════════════════════════════════════
数据源定型（实测定型，证据见 D:\\AStockData\\logs\\diag_D.txt / diag_B.txt）
═══════════════════════════════════════════════════════════════════════
主源：新浪 `money.finance.sina.com.cn/.../CN_MarketData.getKLineData?scale=30&datalen=5000`
  · 沪深北三所统一可用（sh/sz/bj 前缀），实测 0.43~0.95 秒/只
  · 单次 5000 根（≈626 交易日，回溯到 2024-02），足够覆盖 2024-11-04 起的窗口
  · 纯 HTTP、可多线程、无 WAF
  · ⚠️ 返回的是**不复权(raw)**价格 —— 见下方复权处理
  · ⚠️ 不能用 quotes.sina.cn（datalen 上限仅 1023）

弃用：baostock（虽然原生给前复权 + amount，但实测 **41 秒/只** 且**硬崩溃**，
      见 diag_B.txt；全量 5215 只需 ~60 小时，不可用）

复权处理（关键设计）：
  实测（diag_D.txt）Sina 30m 收盘 / dev.db 日K收盘 的比值在**除权日精准跳变**
  （如 sz000001 在 2025-06-12 +3.23%、2025-10-15 +2.14%、2026-06-12 +3.29%），
  且末日比值恰为 1.000000 ⇒ Sina 为不复权，dev.db 日K为前复权。

  ⇒ 按日乘因子：  factor(d) = dev.db日K收盘(d) / Sina原始30m末日收盘(d)
     30m_qfq(d, t) = 30m_raw(d, t) × factor(d)

  好处：得到的 30 分钟 K 与 **V2 日K 完全同一复权基准**，
        图表「日K历史 + 当日30分钟」拼接零跳变；且与项目既有日K口径一致。
  · 对于 dev.db 中 adjust='none' 的 128 只（本身就不复权），factor 自动为 1.0，口径自洽。
  · 只保留 dev.db 日K存在的交易日（= V2 的日期宇宙），保证因子必然可得。

输出：每股一个 Parquet（ZSTD）→ D:\\AStockData\\minutes_30\\<code>.parquet
  列：tradeDate(str) / time(str 'HH:MM:SS') / open / high / low / close(qfq,4位) /
      volume(int64) / amount(double = qfq_close × volume，与项目既有约定一致)

元数据：
  metadata\\stock_list.json     股票清单（由 dev.db 导出）
  metadata\\fetch_status.json  逐股状态（断点续传依据）
  metadata\\intraday_index.json 逐股覆盖索引（供运行时选股快速过滤）

用法：
  python scripts/fetch_30m_kline.py --mode sample --n 20
  python scripts/fetch_30m_kline.py --mode full
  python scripts/fetch_30m_kline.py --mode full --limit 200
  python scripts/fetch_30m_kline.py --codes 600036,000001,920047
  python scripts/fetch_30m_kline.py --mode update
  python scripts/fetch_30m_kline.py --mode verify
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import re
import sqlite3
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import duckdb
import pandas as pd
import requests

# ---------------------------------------------------------------- 配置
ROOT = r"D:\AStockData"
DIR_MIN = os.path.join(ROOT, "minutes_30")
DIR_META = os.path.join(ROOT, "metadata")
DIR_LOGS = os.path.join(ROOT, "logs")
DIR_TMP = os.path.join(ROOT, "temp")
for d in (DIR_MIN, DIR_META, DIR_LOGS, DIR_TMP):
    os.makedirs(d, exist_ok=True)

DB = r"D:\a-share-sim-trading\prisma\dev.db"
STOCK_LIST = os.path.join(DIR_META, "stock_list.json")
STATUS_FILE = os.path.join(DIR_META, "fetch_status.json")
INDEX_FILE = os.path.join(DIR_META, "intraday_index.json")
RUN_LOG = os.path.join(DIR_LOGS, "fetch_30m_run.txt")

SINA_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            "CN_MarketData.getKLineData")
SINA_DATALEN = 5000
SINA_RETRY = 4
SINA_WORKERS = 6
STD_TIMES = ["10:00:00", "10:30:00", "11:00:00", "11:30:00",
             "13:30:00", "14:00:00", "14:30:00", "15:00:00"]
STD_TIME_SET = set(STD_TIMES)
# 日期宇宙下界（上界由 dev.db 日K最大日决定）
START_DATE = "2024-11-04"

# ---------------------------------------------------------------- 日志（逐行落盘）
_print_lock = threading.Lock()
_log_fh = None


def log(*a) -> None:
    global _log_fh
    s = " ".join(str(x) for x in a)
    with _print_lock:
        try:
            if _log_fh is None:
                _log_fh = open(RUN_LOG, "a", encoding="utf-8", buffering=1)
            _log_fh.write(s + "\n")
            _log_fh.flush()
        except Exception:
            pass
        try:
            print(s, flush=True)
        except Exception:
            pass


def atomic_json(path: str, obj) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def load_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# ---------------------------------------------------------------- dev.db
_tls = threading.local()


def _conn() -> sqlite3.Connection:
    c = getattr(_tls, "conn", None)
    if c is None:
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
        _tls.conn = c
    return c


def nd(v) -> str:
    """把 dev.db 的 tradeDate（可能是 ms 整数或 ISO 串）归一为 YYYY-MM-DD"""
    if v is None:
        return ""
    if isinstance(v, (int, float)):
        return dt.datetime.fromtimestamp(v / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
    s = str(v)
    if s.isdigit():
        return dt.datetime.fromtimestamp(int(s) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
    return s[:10]


def load_dayk(code: str) -> dict[str, float]:
    """该股的前复权日K收盘（口径 = stocks.adjust 指定的那一套），{YYYY-MM-DD: close}"""
    cur = _conn().cursor()
    cur.execute(
        "SELECT k.tradeDate, k.close FROM klines k JOIN stocks s ON s.id=k.stockId "
        "WHERE s.code=? AND k.period='1d' AND k.adjust=s.adjust ORDER BY k.tradeDate", (code,))
    rows = cur.fetchall()
    if not rows:
        cur.execute(
            "SELECT k.tradeDate, k.close FROM klines k JOIN stocks s ON s.id=k.stockId "
            "WHERE s.code=? AND k.period='1d' ORDER BY k.tradeDate", (code,))
        rows = cur.fetchall()
    return {nd(d): float(c) for d, c in rows}


def load_dayk_bounds(code: str) -> dict[str, tuple[float, float]]:
    """该股日K的 (high, low)：{YYYY-MM-DD: (high, low)}。用于源端污染收敛。"""
    cur = _conn().cursor()
    cur.execute(
        "SELECT k.tradeDate, k.high, k.low FROM klines k JOIN stocks s ON s.id=k.stockId "
        "WHERE s.code=? AND k.period='1d' AND k.adjust=s.adjust ORDER BY k.tradeDate", (code,))
    rows = cur.fetchall()
    if not rows:
        cur.execute(
            "SELECT k.tradeDate, k.high, k.low FROM klines k JOIN stocks s ON s.id=k.stockId "
            "WHERE s.code=? AND k.period='1d' ORDER BY k.tradeDate", (code,))
        rows = cur.fetchall()
    return {nd(d): (float(h), float(l)) for d, h, l in rows if h and l}


# ---------------------------------------------------------------- 抓取
_JSON_FIX = re.compile(r"([{,])\s*(\w+)\s*:")


def fetch_sina(code: str, exch: str) -> pd.DataFrame:
    """Sina 30 分钟原始（不复权）K 线；按结束时间标注。"""
    url = f"{SINA_URL}?symbol={exch.lower()}{code}&scale=30&ma=no&datalen={SINA_DATALEN}"
    last = None
    for attempt in range(1, SINA_RETRY + 1):
        try:
            r = requests.get(url, timeout=40, proxies={"http": None, "https": None},
                             headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                                      "Referer": "https://finance.sina.com.cn/"})
            r.encoding = "utf-8"
            txt = r.text.strip()
            try:
                data = json.loads(txt)
            except Exception:
                data = json.loads(_JSON_FIX.sub(r'\1"\2":', txt))
            if not isinstance(data, list) or not data:
                return pd.DataFrame()
            df = pd.DataFrame(data)
            if not {"day", "open", "high", "low", "close", "volume"}.issubset(df.columns):
                return pd.DataFrame()
            day = df["day"].astype(str)
            df["tradeDate"] = day.str[:10]
            df["time"] = day.str[11:19]
            for c in ("open", "high", "low", "close"):
                df[c] = pd.to_numeric(df[c], errors="coerce")
            df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0).astype("int64")
            return df[["tradeDate", "time", "open", "high", "low", "close", "volume"]]
        except Exception as e:
            last = e
            if attempt >= SINA_RETRY:
                break
            time.sleep(0.5 * attempt)
    raise RuntimeError(f"sina {code}: {type(last).__name__}: {last}")


def clamp_to_dayk(df: pd.DataFrame, bounds: dict, code: str,
                  ratio: float = 1.5) -> tuple[pd.DataFrame, int]:
    """
    源端污染收敛：把物理不可能的边界值压回**同一根 bar 自身的干净字段**内。

    背景（2026-09-22 取证）：新浪源端在 2026-06-30 对 24 只北交所（920xxx）写入了
    物理不可能的边界值（如 920001 在 14:00 的 high=26681.471），且该污染贯穿其
    5m/15m/30m/60m 全部分钟粒度；腾讯不提供北交所分钟线、东财不可达、网易 DNS 失败，
    故无可用替代源，只能做有界收敛。

    规则（顺序不可调换 —— 必须先修锚点字段 close/open，再修由它们派生的 high/low）：
        close 污染 → close ← open
        open  污染 → open  ← close
        high  污染 → high  ← max(open, close, low)
        low   污染 → low   ← min(open, close, high)
    全程**零跨源注入**（不使用 dev.db 的 H/L 作为取值，只用它做越界判定）。

    阈值 1.5× 是为了不误伤正常的跨源口径差异（如 300176 的 2.4~2.7%，
    共 205 对 >0.5% 全部不受影响）。规则与 scripts/repair_30m_defects.py 完全一致，
    因此**幂等**：全量重抓既不会把污染值写回，也不会二次改动已收敛的数据。
    """
    if not bounds or df.empty:
        return df, 0
    b = pd.DataFrame([(d, h, l) for d, (h, l) in bounds.items()],
                     columns=["tradeDate", "_dh", "_dl"])
    df = df.merge(b, on="tradeDate", how="left")
    lo = df[["open", "high", "low", "close"]].min(axis=1)
    hi = df[["open", "high", "low", "close"]].max(axis=1)
    bad = ((hi > df["_dh"] * ratio) | (lo < df["_dl"] / ratio)).fillna(False).values
    n = 0
    for i in df.index[bad]:
        dh, dl = float(df.at[i, "_dh"]), float(df.at[i, "_dl"])
        o, h, l, c = (float(df.at[i, k]) for k in ("open", "high", "low", "close"))
        bf = [k for k, v in (("open", o), ("high", h), ("low", l), ("close", c))
              if v > dh * ratio or v < dl / ratio]
        if not bf:
            continue
        if "close" in bf:
            c = o
        if "open" in bf:
            o = c
        if "high" in bf:
            h = max(o, c, l)
        if "low" in bf:
            l = min(o, c, h)
        h, l = max(o, h, l, c), min(o, h, l, c)
        for k, v in (("open", o), ("high", h), ("low", l), ("close", c)):
            df.at[i, k] = round(v, 4)
        n += 1
    return df.drop(columns=["_dh", "_dl"]), n


def apply_qfq(df: pd.DataFrame, dayk: dict[str, float],
              bounds: dict | None = None, code: str = "") -> tuple[pd.DataFrame, dict]:
    """
    ① 丢弃每日根数 != 8 的天（Sina 5000 根窗口的首/次日常为残日）
    ② 只保留 dev.db 日K存在的交易日（V2 日期宇宙）
    ③ 按日乘 factor = 日K收盘 / 原始30m末日收盘
    ④ 源端污染收敛（clamp_to_dayk，必须在 OHLC 不变量兜底之前）
    """
    stats: dict = {}
    if df.empty:
        return df, {"dropped_bad_days": 0, "dropped_out_of_universe": 0}
    cnt = df.groupby("tradeDate").size()
    bad_days = set(cnt[cnt != 8].index)
    df = df[~df["tradeDate"].isin(bad_days)]
    stats["dropped_bad_days"] = len(bad_days)

    univ = set(dayk.keys())
    outside = set(df["tradeDate"].unique()) - univ
    stats["dropped_out_of_universe"] = len(outside)
    df = df[df["tradeDate"].isin(univ)]
    if df.empty:
        return df, stats

    # 原始末日收盘（15:00）→ 复权因子
    last = df.loc[df["time"] == "15:00:00", ["tradeDate", "close"]]
    last = last.set_index("tradeDate")["close"].to_dict()
    fac = {}
    for d, raw in last.items():
        q = dayk.get(d)
        if q and raw and raw > 0:
            fac[d] = q / raw
    df = df[df["tradeDate"].isin(fac.keys())].copy()
    if df.empty:
        return df, stats
    df["_f"] = df["tradeDate"].map(fac)
    for c in ("open", "high", "low", "close"):
        df[c] = (df[c].astype("float64") * df["_f"]).round(4)
    # ④ 源端污染收敛：必须在 OHLC 不变量兜底**之前**，
    #    否则 `high = max(O,H,L,C)` 会把垃圾值原样保留下来（这正是它曾躲过 integrity 检查的原因）
    df, stats["clamped_bars"] = clamp_to_dayk(df, bounds, code)
    # OHLC 不变量兜底（缩放 + 舍入后仍保证 high 最大 / low 最小）
    df["high"] = df[["open", "high", "low", "close"]].max(axis=1)
    df["low"] = df[["open", "high", "low", "close"]].min(axis=1)
    df["amount"] = (df["close"] * df["volume"]).round(2)
    df = df.drop(columns=["_f"])
    stats["factor_min"] = round(min(fac.values()), 6)
    stats["factor_max"] = round(max(fac.values()), 6)
    return df[["tradeDate", "time", "open", "high", "low", "close", "volume", "amount"]], stats


def _connect() -> "duckdb.DuckDBPyConnection":
    """受控 DuckDB 连接。

    阶段4 诊断结论：`duckdb.connect()` 默认 memory_limit ≈ 25 GiB（本机 commit 上限仅 33.89 GB，
    可用约 7.3 GB）。在全市场扫描（物化 19M 行）并发进行时，写入线程会因**提交失败**抛
    `OutOfMemoryException: Allocation failure`（002803 即此因）。显式压低上限即可消除该风险。
    """
    con = duckdb.connect()
    con.execute("PRAGMA memory_limit='1GB'")
    con.execute("PRAGMA threads=2")
    return con


def _replace_retry(src: str, dst: str, tries: int = 8, base: float = 0.15) -> None:
    """带退避重试的原子替换。

    阶段4 诊断结论：`os.replace` 在 Windows 上遇到目标被瞬时占用会抛
    `PermissionError: [WinError 5] 拒绝访问`（300710 即此因 —— 其 tmp 内容其实**已完整写出**，
    仅重命名失败）。单次失败即丢弃整只股票的成果代价过高，故退避重试。
    """
    last = None
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except (PermissionError, OSError) as e:
            last = e
            time.sleep(base * (2 ** i))
    raise last


def write_parquet(code: str, df: pd.DataFrame, merge: bool = False) -> dict:
    pq = os.path.join(DIR_MIN, f"{code}.parquet").replace("\\", "/")
    con = _connect()
    try:
        con.register("new_view", df)
        if merge and os.path.exists(pq):
            con.execute(f"""
                COPY (
                  SELECT tradeDate, time, open, high, low, close, volume, amount FROM (
                    SELECT *, ROW_NUMBER() OVER (PARTITION BY tradeDate, time ORDER BY _src DESC) rn
                    FROM (
                      SELECT *, 1 AS _src FROM read_parquet('{pq}')
                      UNION ALL
                      SELECT *, 2 AS _src FROM new_view
                    )
                  ) WHERE rn = 1 ORDER BY tradeDate, time
                ) TO '{pq}.tmp.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
            """)
        else:
            con.execute(
                f"COPY (SELECT * FROM new_view ORDER BY tradeDate, time) "
                f"TO '{pq}.tmp.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)")
        _replace_retry(pq + ".tmp.parquet", pq)
        row = con.execute(
            f"SELECT COUNT(*), COUNT(DISTINCT tradeDate), MIN(tradeDate), MAX(tradeDate) "
            f"FROM read_parquet('{pq}')").fetchone()
    finally:
        con.close()
    return {"bars": int(row[0]), "days": int(row[1]), "first": str(row[2]),
            "last": str(row[3]), "bytes": os.path.getsize(pq)}


def integrity(df: pd.DataFrame) -> list[str]:
    bad = []
    if df.empty:
        return ["empty"]
    if df[["open", "high", "low", "close"]].isna().any().any():
        bad.append("NaN价格")
    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        bad.append("非正价格")
    if (df["high"] < df["low"]).any():
        bad.append("high<low")
    g = df.groupby("tradeDate").size()
    if int(g.min()) != 8 or int(g.max()) != 8:
        bad.append(f"每日根数min={int(g.min())}max={int(g.max())}")
    extra = set(df["time"].unique()) - STD_TIME_SET
    if extra:
        bad.append(f"非标准时点{sorted(extra)[:4]}")
    if df["bars"] if "bars" in df.columns else False:
        pass
    return bad


# ---------------------------------------------------------------- 主流程
def process_one(c: dict, start: str, end: str, merge: bool) -> dict:
    code, exch = c["code"], c["exchange"]
    dayk = load_dayk(code)
    if not dayk:
        return {"status": "no_dayk"}
    bounds = load_dayk_bounds(code)
    raw = fetch_sina(code, exch)
    if raw.empty:
        return {"status": "empty"}
    raw = raw[(raw["tradeDate"] >= start) & (raw["tradeDate"] <= end)]
    if raw.empty:
        return {"status": "empty_range"}
    df, stats = apply_qfq(raw, dayk, bounds=bounds, code=code)
    if df.empty:
        return {"status": "empty_after_qfq", **stats}
    issues = integrity(df)
    meta = write_parquet(code, df, merge=merge)
    meta.update(stats)
    meta["source"] = "sina+qfq(dev.db日K因子)"
    meta["at"] = dt.datetime.now().isoformat()
    meta["status"] = "completed" if not issues else "partial"
    meta["issues"] = issues
    return meta


def run(codes: list[dict], start: str, end: str, workers: int, merge: bool,
        resume: bool = False) -> None:
    log(f"=== fetch_30m mode={'update' if merge else 'full'} codes={len(codes)} "
        f"range={start}..{end} workers={workers} resume={resume} ===")
    status = load_json(STATUS_FILE, {})
    index = load_json(INDEX_FILE, {})

    todo = []
    n_skip = 0
    for c in codes:
        code = c["code"]
        st = status.get(code, {})
        # resume：目标文件已达 end 即跳过（幂等续跑，不重复下载/重写）
        if resume:
            cur_last = (index.get(code) or {}).get("last") or st.get("last") or ""
            if cur_last >= end and os.path.exists(
                    os.path.join(DIR_MIN, f"{code}.parquet")):
                n_skip += 1
                continue
        elif st.get("status") == "completed" and os.path.exists(
                os.path.join(DIR_MIN, f"{code}.parquet")) and not merge:
            n_skip += 1
            continue
        todo.append(c)
    log(f"todo={len(todo)} skip={n_skip}")

    n_ok = n_fail = 0
    t0 = time.time()
    done = 0

    def save() -> None:
        atomic_json(STATUS_FILE, status)
        atomic_json(INDEX_FILE, index)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(process_one, c, start, end, merge): c for c in todo}
        for fut in as_completed(futs):
            c = futs[fut]
            code = c["code"]
            done += 1
            try:
                meta = fut.result()
            except Exception as e:
                meta = {"status": "failed", "error": f"{type(e).__name__}: {e}",
                        "at": dt.datetime.now().isoformat()}
                log(f"  [FAIL] {code}: {type(e).__name__}: {e}")
            status[code] = meta
            if meta.get("status") == "completed":
                n_ok += 1
                index[code] = {"bars": meta["bars"], "days": meta["days"],
                               "first": meta["first"], "last": meta["last"],
                               "source": meta["source"]}
            else:
                n_fail += 1
                if meta.get("status") != "empty":
                    log(f"  [BAD] {code}: {meta.get('status')} {meta.get('issues', '')} "
                        f"{meta.get('error', '')}")
            if done % 50 == 0:
                save()
                el = time.time() - t0
                log(f"  progress {done}/{len(todo)} ok={n_ok} fail={n_fail} "
                    f"elapsed={el:.0f}s rate={done/max(el,1e-9):.2f}/s "
                    f"eta={((len(todo)-done)/max(done/max(el,1e-9),1e-9))/60:.1f}min")
    save()
    log(f"=== DONE ok={n_ok} fail={n_fail} skip={n_skip} elapsed={time.time()-t0:.0f}s ===")
    log(f"status -> {STATUS_FILE}")
    log(f"index  -> {INDEX_FILE}")


# ---------------------------------------------------------------- 校验
def verify() -> None:
    files = sorted(f for f in os.listdir(DIR_MIN) if f.endswith(".parquet"))
    log(f"=== verify: {len(files)} parquet ===")
    con = _connect()
    total_bars = total_bytes = 0
    dist: dict[int, int] = {}
    problems = []
    for i, f in enumerate(files, 1):
        p = os.path.join(DIR_MIN, f).replace("\\", "/")
        try:
            n, d = con.execute(
                f"SELECT COUNT(*), COUNT(DISTINCT tradeDate) FROM read_parquet('{p}')").fetchone()
            total_bars += n
            total_bytes += os.path.getsize(os.path.join(DIR_MIN, f))
            dist[int(d)] = dist.get(int(d), 0) + 1
            if n != d * 8:
                problems.append(f"{f}: bars={n} days={d}")
        except Exception as e:
            problems.append(f"{f}: READ FAIL {str(e)[:80]}")
        if i % 500 == 0:
            log(f"  verified {i}/{len(files)}")
    con.close()
    log(f"total bars={total_bars} bytes={total_bytes} ({total_bytes/1048576:.1f}MB) "
        f"avg={total_bytes/max(total_bars,1):.1f}B/row")
    log(f"days 分布(top12)={sorted(dist.items(), key=lambda x: -x[0])[:12]}")
    log(f"problems={len(problems)}")
    for p in problems[:30]:
        log("  !", p)


# ---------------------------------------------------------------- CLI
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="sample", choices=["sample", "full", "update", "verify"])
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--codes", default="")
    ap.add_argument("--codes-file", default="",
                    help="从文件读代码清单（每行一个，或 JSON 数组 / {toFetch:[...]}）")
    ap.add_argument("--resume", action="store_true",
                    help="幂等续跑：目标文件已达 --end 的股票直接跳过")
    ap.add_argument("--workers", type=int, default=SINA_WORKERS)
    ap.add_argument("--seed", type=int, default=20260921)
    ap.add_argument("--start", default=START_DATE)
    ap.add_argument("--end", default="")
    args = ap.parse_args()

    if args.mode == "verify":
        verify()
        return 0

    stocks = load_json(STOCK_LIST, [])
    if not stocks:
        log("!! stock_list.json 缺失，请先跑 _v3_env_check.py 导出")
        return 2

    # 上界 = dev.db 日K最大交易日（与 V2 日期宇宙一致）
    end = args.end
    if not end:
        try:
            cur = sqlite3.connect(f"file:{DB}?mode=ro", uri=True).cursor()
            cur.execute("SELECT MAX(tradeDate) FROM klines WHERE period='1d'")
            end = nd(cur.fetchone()[0])
        except Exception:
            end = dt.date.today().isoformat()

    if args.codes_file:
        raw = open(args.codes_file, encoding="utf-8").read().strip()
        if raw.startswith("{") or raw.startswith("["):
            obj = json.loads(raw)
            want = set(obj.get("toFetch", []) if isinstance(obj, dict) else obj)
        else:
            want = {x.strip() for x in raw.split() if x.strip()}
        codes = [s for s in stocks if s["code"] in want]
    elif args.codes:
        want = {c.strip() for c in args.codes.split(",") if c.strip()}
        codes = [s for s in stocks if s["code"] in want]
    elif args.mode == "sample":
        rnd = random.Random(args.seed)
        by = {"SH": [], "SZ": [], "BJ": []}
        for s in stocks:
            by.get(s["exchange"], by["SZ"]).append(s)
        n = max(1, args.n)
        n_bj = min(len(by["BJ"]), max(2, n // 5))
        n_sh = (n - n_bj) // 2
        n_sz = n - n_bj - n_sh
        pick = (rnd.sample(by["SH"], min(n_sh, len(by["SH"])))
                + rnd.sample(by["SZ"], min(n_sz, len(by["SZ"])))
                + rnd.sample(by["BJ"], n_bj))
        # 固定补入 3 只已知有分红的（用于检验复权因子）
        for extra in ("600036", "000001", "600000"):
            s = next((x for x in stocks if x["code"] == extra), None)
            if s and s not in pick:
                pick.append(s)
        codes = pick
    else:
        codes = stocks[: args.limit] if args.limit else stocks

    if not codes:
        log("!! 未选中任何代码")
        return 2
    log(f"# run start {dt.datetime.now().isoformat()} argv={sys.argv[1:]} codes={len(codes)}")
    run(codes, args.start, end, args.workers, merge=(args.mode == "update"),
        resume=args.resume)
    return 0


if __name__ == "__main__":
    try:
        import faulthandler

        faulthandler.enable(
            file=open(os.path.join(DIR_LOGS, "faulthandler.txt"), "a", encoding="utf-8"),
            all_threads=True)
    except Exception:
        pass
    try:
        with open(RUN_LOG, "w", encoding="utf-8") as _f:
            _f.write(f"# fetch_30m run start {dt.datetime.now().isoformat()} "
                     f"argv={sys.argv[1:]}\n")
    except Exception:
        pass
    _code = 1
    try:
        _code = main()
    except SystemExit as e:
        _code = int(e.code or 0)
    except BaseException:
        log("FATAL (BaseException)")
        log(traceback.format_exc())
    finally:
        log(f"# exit code={_code}")
    sys.exit(_code)
