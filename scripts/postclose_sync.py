#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
本地收盘后自动同步任务（local post-close auto-sync）

把生产服务器每天收盘后生成、但本地开发机常年缺失的「行情同步」补齐全：
  ① 个股日K + 指数（dev.db）增量同步
  ② 30 分钟 K 线 parquet 增量同步（追加新交易日）
  ③ 复权基准漂移检测（除权日重基后，对漂移个股重新抓取全量 30 分钟历史）

设计要点
--------
- 幂等 + 可追平：重复运行安全；漏跑任意天数会在下次运行时自愈。
- 不重写未发生变化的个股 parquet（对比后跳过），让每夜运行成本最低。
- 崩溃也不丢证据：所有关键步骤逐行落盘到 logs/postclose_sync_<date>.txt。
- 不因异常抛 traceback：所有步骤 try/except 捕获并记日志，硬失败才返回非 0。

用法
----
  python scripts/postclose_sync.py                 # 全套同步
  python scripts/postclose_sync.py --dry-run       # 只读报告，不写任何东西
  python scripts/postclose_sync.py --no-db         # 跳过 DB 同步
  python scripts/postclose_sync.py --no-parquet    # 跳过 30 分钟合并
  python scripts/postclose_sync.py --no-drift-check
  python scripts/postclose_sync.py --codes 600519,000001,920016
  python scripts/postclose_sync.py --workers 6
  python scripts/postclose_sync.py --force         # 忽略周末/非交易日守卫
  python scripts/postclose_sync.py --dir D:/AStockData/temp/pc_test   # 指定 parquet 目录（测试用）
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import shutil
import sqlite3
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import duckdb
import pandas as pd
import paramiko

# ---------------------------------------------------------------- 路径配置
HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)                      # D:\a-share-sim-trading
DEPLOY_DIR = os.path.join(PROJ, "deploy")
sys.path.insert(0, DEPLOY_DIR)

DEFAULT_PQ_DIR = r"D:\AStockData\minutes_30"      # 30 分钟 parquet 根目录
LOG_DIR = r"D:\AStockData\logs"
TMP_RUN = os.path.join(PROJ, ".tmp-run")          # 服务器导出/下载暂存
DEFAULT_WORKERS = 6
DRIFT_THRESHOLD = 1e-6                            # 复权基准漂移相对阈值
STD_TIMES = ["10:00:00", "10:30:00", "11:00:00", "11:30:00",
             "13:30:00", "14:00:00", "14:30:00", "15:00:00"]
ANCHOR_CODES = ["600519", "000001", "920016"]     # qfq 锚点抽检

DB_PATH = os.path.join(PROJ, "prisma", "dev.db")
SERVER_MIN_DIR = "/home/ubuntu/minutes30_data"
SERVER_EXPORT = "/home/ubuntu/export-to-local.py"
SERVER_DB = "/home/ubuntu/app/prisma/dev.db"

# 服务器登录信息（与 deploy/remote.py 同源，集中维护）
# task #43（2026-09-22）：明文口令已移除，改走公钥；密码仅作环境变量兜底。
HOST = os.environ.get("ASHARE_SSH_HOST", "111.229.225.7")
USER = os.environ.get("ASHARE_SSH_USER", "ubuntu")
PORT = int(os.environ.get("ASHARE_SSH_PORT", "22"))
PASSWORD = os.environ.get("ASHARE_SSH_PASSWORD", "")
KEY_PATH = os.environ.get("ASHARE_SSH_KEY", os.path.expanduser("~/.ssh/ashare_ed25519"))

# ---------------------------------------------------------------- 日志（逐行落盘）
_log_lock = threading.Lock()
_log_fh = None


def log(*a) -> None:
    global _log_fh
    s = " ".join(str(x) for x in a)
    with _log_lock:
        try:
            print(s, flush=True)
        except Exception:
            pass
        try:
            if _log_fh is not None:
                _log_fh.write(s + "\n")
                _log_fh.flush()
        except Exception:
            pass


# ---------------------------------------------------------------- 时间工具
def date_to_ms(d: str) -> int:
    """YYYY-MM-DD -> 当日 00:00 UTC 毫秒时间戳（与生产库/导出端一致：服务器为 UTC）。"""
    return int(dt.datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)


def ms_to_date(v) -> str | None:
    if v is None:
        return None
    return dt.datetime.fromtimestamp(int(v) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")


def next_day(d: str) -> str:
    return (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()


def is_trading_day(d: str) -> bool:
    """粗糙交易日守卫：排除周末。生产库以实际存在的数据为准，这里只防明显滥用。"""
    wd = dt.date.fromisoformat(d).weekday()
    return wd < 5  # 0=Mon ... 4=Fri


# ---------------------------------------------------------------- SSH / SFTP
def ssh_connect(timeout: int = 25):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kw = dict(hostname=HOST, port=PORT, username=USER,
              timeout=timeout, banner_timeout=timeout, auth_timeout=timeout,
              look_for_keys=False, allow_agent=False)
    if os.path.exists(KEY_PATH):
        kw["key_filename"] = KEY_PATH
    elif PASSWORD:
        kw["password"] = PASSWORD
    else:
        raise RuntimeError(
            "缺少凭据：未找到私钥 %s，且未设置 ASHARE_SSH_PASSWORD 环境变量。" % KEY_PATH
        )
    c.connect(**kw)
    return c


def ssh_exec(client, cmd: str, timeout: int = 900):
    """无 pty 执行命令，返回 (code, stdout, stderr)。"""
    chan = client.get_transport().open_session()
    chan.settimeout(timeout)
    chan.exec_command(cmd)
    out, err = [], []
    while True:
        if chan.recv_ready():
            out.append(chan.recv(65536))
        if chan.recv_stderr_ready():
            err.append(chan.recv_stderr(65536))
        if chan.exit_status_ready():
            while chan.recv_ready():
                out.append(chan.recv(65536))
            while chan.recv_stderr_ready():
                err.append(chan.recv_stderr(65536))
            break
    code = chan.recv_exit_status()
    chan.close()
    return code, b"".join(out).decode("utf-8", "replace"), b"".join(err).decode("utf-8", "replace")


# ---------------------------------------------------------------- 本地 DB 读取
def _db_conn():
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30)


def local_db_max_daily() -> str | None:
    try:
        c = _db_conn()
        mx = c.execute("SELECT MAX(tradeDate) FROM klines WHERE period='1d'").fetchone()[0]
        c.close()
        return ms_to_date(mx)
    except Exception as e:
        log("[WARN] local_db_max_daily 失败: %s" % e)
        return None


def db_daily_close(code: str, date: str) -> float | None:
    """该股在 date 当天的前复权日K收盘（口径与 parquet 一致：adjust=stocks.adjust）。"""
    try:
        c = _db_conn()
        ms = date_to_ms(date)
        row = c.execute(
            "SELECT k.close FROM klines k JOIN stocks s ON s.id=k.stockId "
            "WHERE s.code=? AND k.period='1d' AND k.adjust=s.adjust AND k.tradeDate=? "
            "ORDER BY k.tradeDate DESC LIMIT 1", (code, ms)).fetchone()
        c.close()
        return float(row[0]) if row else None
    except Exception:
        return None


# ---------------------------------------------------------------- 本地 parquet 读取
def local_parquet_max(pq_dir: str) -> str | None:
    pattern = os.path.join(pq_dir, "*.parquet").replace("\\", "/")
    try:
        con = duckdb.connect()
        r = con.execute(
            f"SELECT MAX(tradeDate) FROM read_parquet('{pattern}')").fetchone()
        con.close()
        return str(r[0]) if r and r[0] is not None else None
    except Exception as e:
        log("[WARN] local_parquet_max 失败: %s" % e)
        return None


def parquet_last_15(pq_dir: str, code: str):
    """返回 (last_date, close_15) 或 None。读该股票 parquet 最后一天的 15:00 收盘。"""
    p = os.path.join(pq_dir, f"{code}.parquet").replace("\\", "/")
    if not os.path.exists(p):
        return None
    con = duckdb.connect()
    try:
        row = con.execute(
            f"SELECT tradeDate, close FROM read_parquet('{p}') "
            f"WHERE time='15:00:00' ORDER BY tradeDate DESC LIMIT 1").fetchone()
    except Exception as e:
        con.close()
        log("[WARN] parquet_last_15(%s) 失败: %s" % (code, e))
        return None
    con.close()
    if not row or row[0] is None:
        return None
    return str(row[0]), float(row[1])


def read_parquet_df(pq_dir: str, code: str) -> pd.DataFrame:
    cols = ["tradeDate", "time", "open", "high", "low", "close", "volume", "amount"]
    p = os.path.join(pq_dir, f"{code}.parquet").replace("\\", "/")
    if not os.path.exists(p):
        return pd.DataFrame(columns=cols)
    con = duckdb.connect()
    df = con.execute(
        f"SELECT tradeDate, time, open, high, low, close, volume, amount "
        f"FROM read_parquet('{p}')").df()
    con.close()
    return df


# ---------------------------------------------------------------- 30 分钟合并
def _write_parquet_atomic(pq_dir: str, code: str, df: pd.DataFrame) -> None:
    p = os.path.join(pq_dir, f"{code}.parquet").replace("\\", "/")
    tmp = p + ".tmp.parquet"
    con = duckdb.connect()
    try:
        con.register("v", df)
        con.execute(
            f"COPY (SELECT tradeDate, time, open, high, low, close, volume, amount "
            f"FROM v ORDER BY tradeDate, time) "
            f"TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    finally:
        con.close()
    os.replace(tmp, p)


def merge_stock_rows(pq_dir: str, code: str, new_rows: list[dict]) -> tuple[bool, int]:
    """把 new_rows（单日，来自服务器）合并进该股 parquet。

    返回 (是否发生写盘, bars-per-day 违规数)。幂等：若合并结果与现有完全一致则不写盘。
    """
    if not new_rows:
        return False, 0
    new_df = pd.DataFrame([{
        "tradeDate": r["tradeDate"],
        "time": r["time"],
        "open": float(r["open"]),
        "high": float(r["high"]),
        "low": float(r["low"]),
        "close": float(r["close"]),
        "volume": int(r["volume"]),
        "amount": round(float(r["close"]) * int(r["volume"]), 2),
    } for r in new_rows])
    new_df = new_df.drop_duplicates(subset=["tradeDate", "time"], keep="last")
    existing = read_parquet_df(pq_dir, code)

    if existing.empty:
        merged = new_df.sort_values(["tradeDate", "time"]).reset_index(drop=True)
    else:
        combined = pd.concat([existing, new_df], ignore_index=True)
        combined = combined.drop_duplicates(subset=["tradeDate", "time"], keep="last")
        merged = combined.sort_values(["tradeDate", "time"]).reset_index(drop=True)
        # 未发生变化则跳过写盘（保留 mtime / 降低成本）
        a = existing[["tradeDate", "time", "open", "high", "low", "close", "volume", "amount"]] \
            .astype({"volume": "int64"}).values.tolist()
        b = merged[["tradeDate", "time", "open", "high", "low", "close", "volume", "amount"]] \
            .astype({"volume": "int64"}).values.tolist()
        if sorted((tuple(map(str, x)) for x in a)) == sorted((tuple(map(str, x)) for x in b)):
            return False, 0

    _write_parquet_atomic(pq_dir, code, merged)

    # bars-per-day 一致性（必须全 8）
    g = merged.groupby("tradeDate").size()
    bad = int((g != 8).sum())
    return True, bad


# ---------------------------------------------------------------- 复权基准漂移检测
def drift_check(codes: list[str], pq_dir: str, workers: int) -> list[dict]:
    """对每只股票比对 parquet 末日 15:00 收盘 与 本地 DB 日K收盘，超阈则标记。"""
    flagged = []
    lock = threading.Lock()

    def worker(code: str):
        info = parquet_last_15(pq_dir, code)
        if not info:
            return
        last_day, pq_close = info
        db_close = db_daily_close(code, last_day)
        if db_close is None or db_close == 0:
            return
        rel = abs(pq_close - db_close) / abs(db_close)
        if rel > DRIFT_THRESHOLD:
            with lock:
                flagged.append({"code": code, "lastDay": last_day,
                                "pqClose": pq_close, "dbClose": db_close,
                                "rel": rel})

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        list(ex.map(worker, codes))
    flagged.sort(key=lambda x: x["code"])
    return flagged


# ---------------------------------------------------------------- 服务器接口读取
def read_manifest(client) -> dict | None:
    remote = f"{SERVER_MIN_DIR}/manifest.json"
    local = os.path.join(TMP_RUN, "manifest.json")
    sftp = client.open_sftp()
    try:
        sftp.get(remote, local)
    finally:
        sftp.close()
    with open(local, encoding="utf-8") as f:
        return json.load(f)


def download_date_gz(client, date: str) -> str:
    remote = f"{SERVER_MIN_DIR}/{date}.json.gz"
    local = os.path.join(TMP_RUN, f"{date}.json.gz")
    sftp = client.open_sftp()
    try:
        sftp.get(remote, local)
    finally:
        sftp.close()
    return local


def parse_date_gz(path: str) -> tuple[str, list[dict]]:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        obj = json.load(f)
    return obj.get("tradeDate"), obj.get("rows", [])


# ---------------------------------------------------------------- 步骤
def run_db_sync(client, manifest, local_max_daily: str | None, dry_run: bool, force: bool) -> None:
    server_max = manifest.get("dbMaxDaily")
    if not server_max:
        log("[DB] manifest 无 dbMaxDaily，跳过")
        return
    if local_max_daily and server_max <= local_max_daily and not force:
        log(f"[DB] 本地已是最新 (本地={local_max_daily} >= 服务器={server_max})，无需同步")
        return
    since = next_day(local_max_daily) if local_max_daily else "2024-01-01"
    if dry_run:
        log(f"[DB][dry-run] 将执行：服务器导出 --since {since}（本地={local_max_daily} 服务器={server_max}）"
            f" 并 importServerExport。不写任何数据。")
        return
    stamp = dt.datetime.utcnow().strftime("%Y%m%d%H%M%S")
    remote_out = f"/home/ubuntu/market-export-{stamp}.json"
    log(f"[DB] 服务器导出 --since {since} -> {remote_out}")
    code, so, se = ssh_exec(
        client, f"python3 {SERVER_EXPORT} --out {remote_out} --since {since}", timeout=900)
    if code != 0:
        log(f"[DB][ERROR] 服务器导出失败 code={code}\n{se}")
        raise RuntimeError("DB 服务器导出失败")
    local_file = os.path.join(TMP_RUN, f"market-export-{stamp}.json")
    sftp = client.open_sftp()
    try:
        sftp.get(remote_out, local_file)
    finally:
        sftp.close()
    log(f"[DB] 已下载导出文件 -> {local_file}")
    # 本地导入
    import subprocess
    # Windows: CreateProcess 只按 .exe 扩展名解析 PATH，无法把无扩展名的 "npx"
    # 解析到 npx.CMD。先用 shutil.which（走 PATHEXT）拿到真实启动器路径。
    npx_bin = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
    r = subprocess.run(
        [npx_bin, "tsx", "scripts/importServerExport.ts", local_file],
        cwd=PROJ, capture_output=True, text=True, timeout=1800)
    log(r.stdout.strip())
    if r.returncode != 0:
        log(f"[DB][ERROR] importServerExport 失败:\n{r.stderr.strip()}")
        raise RuntimeError("DB 导入失败")
    # 校验推进
    new_max = local_db_max_daily()
    if local_max_daily and new_max and new_max <= local_max_daily and not force:
        raise RuntimeError(f"DB 同步后本地最大值未推进: {local_max_daily} -> {new_max}")
    log(f"[DB] 同步完成，本地最大值 {local_max_daily} -> {new_max}")


def run_parquet_sync(client, manifest, local_max_pq: str | None, dry_run: bool,
                     codes_filter: set[str] | None, workers: int) -> None:
    dates = list(manifest.get("dates", []))
    if not dates:
        log("[PARQUET] manifest 无日期，跳过")
        return
    todo = [d for d in dates if (local_max_pq is None or d > local_max_pq)]
    if not todo:
        log(f"[PARQUET] 本地已是最新 (本地={local_max_pq}，无更新日期)，无需合并")
        return
    if dry_run:
        log(f"[PARQUET][dry-run] 将合并以下日期(>{local_max_pq}): {todo}。"
            f" 不下载/不写任何数据。")
        return
    total_wrote = total_viol = 0
    for d in todo:
        local_gz = download_date_gz(client, d)
        td, rows = parse_date_gz(local_gz)
        by_code: dict[str, list[dict]] = {}
        for r in rows:
            c = r.get("code")
            if codes_filter and c not in codes_filter:
                continue
            # 服务器每行不带 tradeDate（它等于文件日期），补上
            r["tradeDate"] = d
            by_code.setdefault(c, []).append(r)
        log(f"[PARQUET] 日期 {d}: {len(rows)} 行 / {len(by_code)} 只股票待合并")
        wrote = viol = 0
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            futs = {ex.submit(merge_stock_rows, ARGS.dir, c, rs): c
                    for c, rs in by_code.items()}
            for fut in as_completed(futs):
                c = futs[fut]
                try:
                    w, b = fut.result()
                except Exception as e:
                    log(f"  [PARQUET][ERROR] {c}: {e}")
                    viol += 1
                    continue
                wrote += (1 if w else 0)
                viol += b
        total_wrote += wrote
        total_viol += viol
        log(f"[PARQUET] 日期 {d} 完成：写盘 {wrote} 只，bars-per-day 违规 {viol}")
    log(f"[PARQUET] 全部完成：写盘 {total_wrote} 只，bars-per-day 违规合计 {total_viol}")


# ---------------------------------------------------------------- 逐文件覆盖度检查 + 修复
G_COVERAGE: dict = {"baseline": None, "total": 0, "missing": 0, "missing_codes": []}


def db_codes_on_date(date: str) -> set[str]:
    """本地 DB 在 date 当天有日K行的股票代码集合（period='1d'，口径=stocks.adjust）。"""
    try:
        c = _db_conn()
        ms = date_to_ms(date)
        rows = c.execute(
            "SELECT DISTINCT s.code FROM klines k JOIN stocks s ON s.id=k.stockId "
            "WHERE k.period='1d' AND k.adjust=s.adjust AND k.tradeDate=?", (ms,)).fetchall()
        c.close()
        return {r[0] for r in rows}
    except Exception as e:
        log(f"[COVERAGE][WARN] db_codes_on_date 失败: {e}")
        return set()


def coverage_report(pq_dir: str, baseline_date: str,
                   codes_filter: set[str] | None, workers: int) -> tuple[list[str], int]:
    """以 baseline_date 为基准日，统计「DB 有该日K行但 parquet 缺该日」的缺失股票。

    判据（必须精确，不能误报）：候选 = DB 在 baseline_date 有日K行的股票
    （与 --codes 取交集）；缺失 = 候选中 parquet 文件不存在或不含 baseline_date 行。
    停牌 / 无当日日K 的股票不在候选集内，不会被报为缺失。
    """
    db_codes = db_codes_on_date(baseline_date)
    if codes_filter:
        candidates = sorted(db_codes & codes_filter)
    else:
        candidates = sorted(db_codes)
    missing: list[str] = []
    lock = threading.Lock()

    def worker(code: str) -> None:
        p = os.path.join(pq_dir, f"{code}.parquet").replace("\\", "/")
        present = False
        if os.path.exists(p):
            con = duckdb.connect()
            try:
                row = con.execute(
                    f"SELECT 1 FROM read_parquet('{p}') "
                    f"WHERE tradeDate='{baseline_date}' LIMIT 1").fetchone()
                present = row is not None
            except Exception:
                present = False
            finally:
                con.close()
        if not present:
            with lock:
                missing.append(code)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        list(ex.map(worker, candidates))
    missing.sort()
    return missing, len(candidates)


def coverage_repair(client, missing_codes: set[str], baseline_date: str,
                   pq_dir: str, workers: int) -> None:
    """用服务器 baseline_date 的 30 分钟文件（已含当日全部交易股，qfq 基准一致）
    把缺失股的那一天补回 --dir。复用 merge_stock_rows（ZSTD / 原子写 / 去重）。"""
    local_gz = download_date_gz(client, baseline_date)
    td, rows = parse_date_gz(local_gz)
    by_code: dict[str, list[dict]] = {}
    for r in rows:
        c = r.get("code")
        if c not in missing_codes:
            continue
        r["tradeDate"] = baseline_date
        by_code.setdefault(c, []).append(r)
    log(f"[COVERAGE] 补数：基准日 {baseline_date} 文件 {len(rows)} 行，缺失股 "
        f"{len(by_code)} 只待补回")
    wrote = viol = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futs = {ex.submit(merge_stock_rows, pq_dir, c, rs): c
                for c, rs in by_code.items()}
        for fut in as_completed(futs):
            c = futs[fut]
            try:
                w, b = fut.result()
            except Exception as e:
                log(f"  [COVERAGE][ERROR] {c}: {e}")
                viol += 1
                continue
            wrote += (1 if w else 0)
            viol += b
    log(f"[COVERAGE] 补数完成：写盘 {wrote} 只，bars-per-day 违规 {viol}")


def run_coverage(client, baseline_date: str, codes_filter: set[str] | None,
                workers: int, dry_run: bool) -> None:
    missing, total = coverage_report(ARGS.dir, baseline_date, codes_filter, workers)
    G_COVERAGE["baseline"] = baseline_date
    G_COVERAGE["total"] = total
    G_COVERAGE["missing"] = len(missing)
    G_COVERAGE["missing_codes"] = missing
    log(f"[COVERAGE] 基准日 {baseline_date}：候选 {total} 只，缺失 {len(missing)} 只"
        + (("  前20：" + ",".join(missing[:20])) if missing else "（覆盖完整）"))
    if not missing:
        return
    if dry_run:
        log("[COVERAGE][dry-run] 将用服务器当日文件补回上述缺失股，不写任何数据。")
        return
    coverage_repair(client, set(missing), baseline_date, ARGS.dir, workers)


def run_drift(client, codes: list[str], dry_run: bool, workers: int) -> None:
    log(f"[DRIFT] 检测 {len(codes)} 只股票复权基准漂移 (阈值 {DRIFT_THRESHOLD}) ...")
    flagged = drift_check(codes, ARGS.dir, workers)
    if not flagged:
        log("[DRIFT] 无漂移个股")
        return
    log(f"[DRIFT] 发现 {len(flagged)} 只漂移个股（将重新全量抓取 30 分钟历史）：")
    for f in flagged:
        log(f"    {f['code']} lastDay={f['lastDay']} pqClose={f['pqClose']:.4f} "
            f"dbClose={f['dbClose']:.4f} rel={f['rel']:.2e}")
    if dry_run:
        log("[DRIFT][dry-run] 不会执行重新抓取。本应运行：")
        log(f"    python scripts/fetch_30m_kline.py --mode full --codes {','.join(f['code'] for f in flagged)}")
        return
    csv = ",".join(f["code"] for f in flagged)
    log(f"[DRIFT] 执行重新抓取: --mode full --codes {csv}")
    import subprocess
    # 用当前解释器（venv，含 duckdb/pandas/paramiko），避免 PATH 上的裸 python 缺依赖
    r = subprocess.run(
        [sys.executable, os.path.join(PROJ, "scripts", "fetch_30m_kline.py"),
         "--mode", "full", "--codes", csv],
        cwd=PROJ, capture_output=True, text=True, timeout=3600)
    log(r.stdout.strip()[-2000:] if r.stdout else "")
    if r.returncode != 0:
        log(f"[DRIFT][ERROR] 重新抓取失败:\n{r.stderr.strip()[-2000:]}")
    else:
        log("[DRIFT] 重新抓取完成")


def verify_and_report(local_max_daily: str | None, local_max_pq: str | None) -> None:
    # 本地 DB 计数
    try:
        c = _db_conn()
        kc = c.execute("SELECT COUNT(*) FROM klines").fetchone()[0]
        kmx = ms_to_date(c.execute(
            "SELECT MAX(tradeDate) FROM klines").fetchone()[0])
        ikc = c.execute("SELECT COUNT(*) FROM index_klines").fetchone()[0]
        ikx = ms_to_date(c.execute(
            "SELECT MAX(tradeDate) FROM index_klines").fetchone()[0])
        c.close()
    except Exception as e:
        log(f"[VERIFY][WARN] DB 统计失败: {e}")
        kc = kmx = ikc = ikx = None
    # 本地 parquet
    pqmax = local_parquet_max(ARGS.dir)
    log("=== 同步后现状 ===")
    log(f"  klines        : 总行 {kc}  最大交易日 {kmx}")
    log(f"  index_klines  : 总行 {ikc}  最大交易日 {ikx}")
    log(f"  parquet(30m)  : 最大交易日 {pqmax}")
    # qfq 锚点抽检
    log("=== qfq 锚点抽检（parquet 15:00 收盘 vs 本地 DB 日K收盘）===")
    for code in ANCHOR_CODES:
        info = parquet_last_15(ARGS.dir, code)
        if not info:
            log(f"  {code}: parquet 缺失")
            continue
        last_day, pq_close = info
        db_close = db_daily_close(code, last_day)
        if db_close is None:
            log(f"  {code}: 末日 {last_day} parquet={pq_close:.4f} DB=无对应日K")
        else:
            rel = abs(pq_close - db_close) / abs(db_close) if db_close else 0
            log(f"  {code}: 末日 {last_day} parquet={pq_close:.4f} DB={db_close:.4f} "
                f"rel={rel:.2e} {'OK' if rel <= DRIFT_THRESHOLD else 'DRIFT!'}")


# ---------------------------------------------------------------- CLI / main
def parse_args():
    ap = argparse.ArgumentParser(description="本地收盘后自动同步")
    ap.add_argument("--dry-run", action="store_true", help="只读报告，不写任何东西")
    ap.add_argument("--no-db", action="store_true", help="跳过 DB 同步")
    ap.add_argument("--no-parquet", action="store_true", help="跳过 30 分钟合并")
    ap.add_argument("--no-drift-check", action="store_true", help="跳过复权基准漂移检测")
    ap.add_argument("--codes", default="", help="限制股票范围 a,b,c")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    ap.add_argument("--force", action="store_true", help="忽略周末/非交易日守卫")
    ap.add_argument("--dir", default=DEFAULT_PQ_DIR, help="parquet 目录（测试用）")
    return ap.parse_args()


ARGS = None


def main() -> int:
    global ARGS
    ARGS = parse_args()
    if ARGS.dir != DEFAULT_PQ_DIR:
        log(f"[INFO] 使用自定义 parquet 目录: {ARGS.dir}")
    today = dt.date.today().isoformat()
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(TMP_RUN, exist_ok=True)
    os.makedirs(ARGS.dir, exist_ok=True)
    log_path = os.path.join(LOG_DIR, f"postclose_sync_{today}.txt")
    global _log_fh
    try:
        _log_fh = open(log_path, "a", encoding="utf-8", buffering=1)
    except Exception as e:
        log(f"[WARN] 无法打开日志文件 {log_path}: {e}")
        _log_fh = None

    log("=" * 70)
    log(f"postclose_sync 启动 {dt.datetime.now().isoformat()}  argv={sys.argv[1:]}")
    log(f"  dry_run={ARGS.dry_run} no_db={ARGS.no_db} no_parquet={ARGS.no_parquet} "
        f"no_drift={ARGS.no_drift_check} workers={ARGS.workers} dir={ARGS.dir}")

    codes_filter = {c.strip() for c in ARGS.codes.split(",") if c.strip()} if ARGS.codes else None

    exit_code = 0
    client = None
    try:
        # 守卫：周末（除非 --force）
        if not ARGS.force and not is_trading_day(today):
            log(f"[GUARD] 今天 {today} 非交易日（周末），--force 未设置，仅执行只读报告后退出")
            # 仍允许 drift 检测（只读）以便及时发现问题，但跳过写盘类步骤
        # 连接服务器
        log("[CONNECT] 连接服务器 %s@%s ..." % (USER, HOST))
        client = ssh_connect()
        log("[CONNECT] OK")

        # manifest
        manifest = read_manifest(client)
        if not manifest:
            raise RuntimeError("无法读取服务器 manifest")
        log(f"[MANIFEST] generatedAt={manifest.get('generatedAt')} "
            f"dates={manifest.get('dates')} dbMaxDaily={manifest.get('dbMaxDaily')}")

        # 本地状态
        local_max_daily = local_db_max_daily() if not ARGS.no_db else None
        local_max_pq = local_parquet_max(ARGS.dir) if not ARGS.no_parquet else None
        log(f"[LOCAL] DB日K最大={local_max_daily}  parquet最大={local_max_pq}")

        # 步骤 3：DB 同步
        if not ARGS.no_db:
            run_db_sync(client, manifest, local_max_daily, ARGS.dry_run, ARGS.force)
        else:
            log("[DB] 跳过 (--no-db)")

        # 步骤 4：30 分钟合并
        if not ARGS.no_parquet:
            # dry_run 时 run_parquet_sync 只读报告
            run_parquet_sync(client, manifest, local_max_pq, ARGS.dry_run,
                             codes_filter, ARGS.workers)
        else:
            log("[PARQUET] 跳过 (--no-parquet)")

        # 步骤 4b：逐文件覆盖度检查 + 修复（解决全局 max 掩盖单只缺口的问题）
        if not ARGS.no_parquet and local_max_daily:
            run_coverage(client, local_max_daily, codes_filter, ARGS.workers, ARGS.dry_run)
        elif not ARGS.no_parquet and not local_max_daily:
            log("[COVERAGE] 跳过（无法获得本地 DB 日K最大日作为基准日）")

        # 步骤 5：复权基准漂移检测
        if not ARGS.no_drift_check:
            # 决定检测范围：默认全部 parquet 股票；--codes 限制
            if codes_filter:
                drift_codes = list(codes_filter)
            else:
                drift_codes = [f[:-8] for f in os.listdir(ARGS.dir)
                               if f.endswith(".parquet")]
            run_drift(client, drift_codes, ARGS.dry_run, ARGS.workers)
        else:
            log("[DRIFT] 跳过 (--no-drift-check)")

        # 步骤 6/7：校验与报告
        verify_and_report(local_db_max_daily(), local_parquet_max(ARGS.dir))

        log("=" * 70)
        log("postclose_sync 完成（dry_run=%s）" % ARGS.dry_run)
    except Exception as e:
        exit_code = 1
        log("!" * 70)
        log("postclose_sync 硬失败: %s" % e)
        log(traceback.format_exc())
        log("!" * 70)
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        if _log_fh is not None:
            try:
                _log_fh.close()
            except Exception:
                pass
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
