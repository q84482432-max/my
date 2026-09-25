#!/usr/bin/env bash
# 组装 Next.js standalone 产物并打包，供上传到服务器。
#
# 用法：bash deploy/pack-standalone.sh [输出路径]
#      默认输出 .tmp-run/ashare-standalone.tar.gz
#
# 为什么需要这个脚本：
#   `next build` 产出的 .next/standalone 只含 server.js + node_modules + .next(server 侧)，
#   **不含 .next/static 与 public** —— 这两块必须手工复制进去，否则线上页面无 JS/CSS。
#   同时必须确保包里没有 prisma/dev.db，否则部署时会覆盖线上 770MB 生产库。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/.tmp-run/ashare-standalone.tar.gz}"
STD="$ROOT/.next/standalone"

# 本机（Windows Git Bash）PATH 里 `find` 会命中 C:\Windows\System32\find.exe —— 那是
# 「按文本搜索」的另一个命令，把 -type/-name 当非法开关（报 `FIND: 无效的开关`），
# 且静默返回 0，导致文件计数恒为 0、__pycache__ 清理静默失效。
# 这里显式探测一个真正的 GNU find，避免踩这个坑。
FIND_BIN=""
for _c in /usr/bin/find /bin/find /usr/local/bin/find "$(command -v gfind 2>/dev/null || true)"; do
  if [ -n "$_c" ] && [ -x "$_c" ] && "$_c" --version 2>/dev/null | grep -q 'GNU findutils'; then
    FIND_BIN="$_c"; break
  fi
done
if [ -n "$FIND_BIN" ]; then
  echo "GNU find: $FIND_BIN ($("$FIND_BIN" --version | head -1))"
else
  echo "WARN: 未找到 GNU find，将退化为 bash globstar（功能等价）"
fi

# 同理：`tar` 会命中 C:\Windows\System32\tar（bsdtar），它不认 `/d/...` 这种 MSYS 路径，
# 报 `Failed to open '/d/...'`。显式挑 GNU tar。
TAR_BIN=""
for _c in /usr/bin/tar /bin/tar /usr/local/bin/tar "$(command -v gtar 2>/dev/null || true)"; do
  if [ -n "$_c" ] && [ -x "$_c" ] && "$_c" --version 2>/dev/null | grep -q 'GNU tar'; then
    TAR_BIN="$_c"; break
  fi
done
if [ -n "$TAR_BIN" ]; then
  echo "GNU tar: $TAR_BIN ($("$TAR_BIN" --version | head -1))"
else
  echo "FATAL: 未找到 GNU tar；Windows 自带 bsdtar 不认 MSYS 路径。"
  echo "       请安装 Git for Windows 的 tar，或把 GNU tar 放到 /usr/bin。"
  exit 1
fi

# 递归删掉某目录下所有 __pycache__（字节码里会残留字符串常量）
purge_pycache() {
  local d="$1"
  if [ -n "$FIND_BIN" ]; then
    "$FIND_BIN" "$d" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  else
    shopt -s globstar nullglob 2>/dev/null || true
    local p
    for p in "$d"/**/__pycache__; do [ -d "$p" ] && rm -rf "$p"; done
    shopt -u globstar nullglob 2>/dev/null || true
  fi
}

echo "=== [1/4] 校验构建产物 ==="
if [ ! -f "$STD/server.js" ]; then
  echo "FATAL: $STD/server.js 不存在。请先执行 npm run build"
  exit 1
fi
echo "OK: server.js 存在"

echo "=== [2/4] 复制 .next/static 与 public（standalone 不自带）==="
mkdir -p "$STD/.next"
rm -rf "$STD/.next/static"
cp -a "$ROOT/.next/static" "$STD/.next/static"
echo "OK: .next/static 已复制（$(if [ -n "$FIND_BIN" ]; then "$FIND_BIN" "$STD/.next/static" -type f | wc -l; else echo "?"; fi) 文件）"
if [ -d "$ROOT/public" ]; then
  rm -rf "$STD/public"
  cp -a "$ROOT/public" "$STD/public"
  echo "OK: public 已复制"
else
  echo "SKIP: 项目无 public 目录"
fi

echo "=== [2b/4] 附带 schema 指纹与副本（供部署脚本做一致性检查 / 可选同步）==="
# 事故复盘（2026-09-22）：deploy-inplace.sh 出于防覆盖生产库的考虑从不同步 prisma/，
# 导致 V2 的 schema 变更长期未上服务器，部署后走库接口全报
# `Unknown field stage for select statement`（500）。此处把本次构建所用 schema 的
# 指纹与副本放进包里，让服务器侧能提前发现「代码新、schema 旧」。
cp -f "$ROOT/prisma/schema.prisma" "$STD/SCHEMA.prisma"
md5sum "$ROOT/prisma/schema.prisma" | cut -d' ' -f1 > "$STD/SCHEMA-MD5.txt"
echo "OK: SCHEMA-MD5.txt = $(cat "$STD/SCHEMA-MD5.txt")"

echo "=== [3/4] 安全检查：禁止打包生产数据库 ==="
FOUND=0
for f in "$STD/prisma/dev.db" "$STD/prisma/dev.db-journal" "$STD/prisma/dev.db-wal" "$STD/prisma/dev.db-shm" "$STD/.env"; do
  if [ -e "$f" ]; then
    rm -f "$f"
    echo "已移除: ${f#$STD/}"
    FOUND=1
  fi
done
[ "$FOUND" = "0" ] && echo "OK: 无生产库/凭据文件"

echo "=== [3b/4] 安全检查：禁止打包硬编码凭据 ==="
# 事故复盘（2026-09-22，task #43）：Next.js standalone 的 file tracing 会把项目根目录
# 的一批文件（deploy/、scripts/、_sftp_get.py 等）一并拷进 .next/standalone，
# 于是 `deploy/remote.py` 里的明文 SSH 口令被原样打进了部署包 —— 而 .tar.gz 是二进制，
# 在服务器上 `grep -r` 根本搜不到，直到解包逐文件查才暴露。
# 因此这里在打包前做一次「静态凭据闸门」：命中即拒绝打包（不是警告）。
# 扫描范围**只含项目自有文件**（排除 node_modules 与 .next 编译产物）——
# 后者内含大量第三方库的 password 字面量，扫它们会把正常构建全部误杀。
# 检测器要求「赋值给一个字面量且长度 ≥ 8」，这样注释里举例用的 password = "..." 
# 与文档字符串里的 password='xxx' 都不会误报；而 os.environ.get() 这类动态取值
# 本来就不该命中 —— 那才是正解。
purge_pycache "$STD"
CRED_RE="(^[[:space:]]*[A-Za-z_]*[Pp]ASSWORD[[:space:]]*=[[:space:]]*[\"'][^\"']{8,}[\"']|[\"'][Pp]assword[\"'][[:space:]]*:[[:space:]]*[\"'][^\"']{8,}[\"'])"
CRED_HITS="$(grep -rlE "$CRED_RE" "$STD" \
  --exclude-dir=node_modules --exclude-dir=.next \
  --include='*.py' --include='*.sh' --include='*.js' --include='*.mjs' \
  --include='*.cjs' --include='*.ts' --include='*.tsx' --include='*.json' 2>/dev/null || true)"
if [ -n "$CRED_HITS" ]; then
  echo "FATAL: 构建产物内发现硬编码口令字面量，拒绝打包："
  echo "$CRED_HITS" | sed 's|^|  |'
  echo "处置：把凭据改为读环境变量（模板见 deploy/remote.example.py），再重新 npm run build。"
  exit 1
fi
echo "OK: 无硬编码口令（已清理 __pycache__）"

echo "=== [3c/4] 清理非运行时文件 ==="
# 背景（2026-09-23 实测）：`outputFileTracingRoot` 指向项目根时，Next 会把根目录下**几乎全部**
# 文件 trace 进 .next/standalone —— 实测包含 813MB 的 `prisma/test.db`、26MB 的
# `deploy-bundle.tar.gz`、上百个 `_*.py` 调试探针、日志与 `store/` 缓存，
# 让产物从 ~100MB 膨胀到 **917MB**（压缩后 257MB，上传成本高 4 倍）。
#
# 更严重的是**卫生问题**：测试数据库被原样打进部署包。而 `deploy-inplace.sh` 的
# 黑名单只拦 `prisma/dev.db`，**拦不住 `prisma/test.db`** —— 这类「把库塞进包里」的错误
# 正是 2026-09-22 那次事故的同族，必须在源头掐掉。
#
# 运行时真正需要的只有：`server.js` + `.next/`（含 static）+ `SCHEMA-MD5.txt` + `SCHEMA.prisma`
# （`node_modules/` 仅在 `--with-modules` 部署时才用得上，保留不动。）
PRUNE_FILES=(
  "prisma/dev.db" "prisma/dev.db-journal" "prisma/dev.db-wal" "prisma/dev.db-shm"
  "prisma/test.db" "prisma/test.db-journal" "prisma/test.db-wal" "prisma/test.db-shm"
  "deploy-bundle.tar.gz" "tsconfig.tsbuildinfo" "build-standalone.log" "probe.txt"
)
for _f in "${PRUNE_FILES[@]}"; do
  if [ -e "$STD/$_f" ]; then rm -f "$STD/$_f"; echo "  - $_f"; fi
done
if [ -n "$FIND_BIN" ]; then
  # 日志 + `_` 前缀探针（本项目的探针命名约定）
  "$FIND_BIN" "$STD" -maxdepth 1 -type f \( -name '*.log' -o -name '_*' \) -delete 2>/dev/null || true
  # store/（Next 缓存）、scripts/ 与 deploy/（运行时不需要；deploy/ 含 SSH 辅助脚本，属凭据卫生）
  "$FIND_BIN" "$STD" -maxdepth 1 -type d \( -name 'store' -o -name 'scripts' -o -name 'deploy' \) -exec rm -rf {} + 2>/dev/null || true
else
  for _p in "$STD"/*.log "$STD"/_*; do [ -e "$_p" ] && rm -rf "$_p"; done
  for _d in store scripts deploy; do [ -d "$STD/$_d" ] && rm -rf "$STD/$_d"; done
fi
echo "OK: 已清理非运行时文件"

echo "=== [3d/4] 硬闸门：产物内不得存在任何数据库文件 ==="
DB_LEFT=""
if [ -n "$FIND_BIN" ]; then
  DB_LEFT="$("$FIND_BIN" "$STD" \( -name '*.db' -o -name '*.db-journal' -o -name '*.db-wal' -o -name '*.db-shm' \) 2>/dev/null | head -20 || true)"
fi
if [ -n "$DB_LEFT" ]; then
  echo "FATAL: 产物内仍存在数据库文件，拒绝打包（这会在部署时污染/浪费上传）："
  echo "$DB_LEFT" | sed 's|^|  |'
  exit 1
fi
echo "OK: 无任何 .db 产物"

echo "=== [3e/4] 诊断：产物内的符号链接（Windows→Linux 的静默损坏源）==="
# 事故复盘（2026-09-23）：Turbopack 的哈希别名在 Windows 构建时会变成
# **指向 Windows 路径的悬空软链**（如 `client-2c3a... -> /d/a-share-sim-trading/...`）。
# 这类链接解到 Linux 上必然解析失败，导致 require 抛 MODULE_NOT_FOUND、走库接口全 500。
# 服务端 `deploy-inplace.sh` 的 [4b/7] 现在会修它并带硬闸门；这里只是把「包里有几个链接、
# 指向哪里」显式打印出来，方便出事时一眼定位，而不是让人去猜。
if [ -n "$FIND_BIN" ]; then
  SYMLINKS="$("$FIND_BIN" "$STD" -type l -printf '%p -> %l\n' 2>/dev/null || true)"
  if [ -n "$SYMLINKS" ]; then
    echo "  注意：包内存在符号链接（服务端会校验可解析性）："
    printf '%s\n' "$SYMLINKS" | sed 's|^|    |'
  else
    echo "  OK: 包内无符号链接"
  fi
fi

echo "=== [4/4] 打包 ==="
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
"$TAR_BIN" czf "$OUT" -C "$STD" .
echo "产物: $OUT"
echo "大小: $(du -h "$OUT" | cut -f1)"
echo "文件数: $("$TAR_BIN" tzf "$OUT" | wc -l)"
echo "MD5: $(md5sum "$OUT" | cut -d' ' -f1)"
