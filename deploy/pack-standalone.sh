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
echo "OK: .next/static 已复制（$(find "$STD/.next/static" -type f | wc -l) 文件）"
if [ -d "$ROOT/public" ]; then
  rm -rf "$STD/public"
  cp -a "$ROOT/public" "$STD/public"
  echo "OK: public 已复制"
else
  echo "SKIP: 项目无 public 目录"
fi

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

echo "=== [4/4] 打包 ==="
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
tar czf "$OUT" -C "$STD" .
echo "产物: $OUT"
echo "大小: $(du -h "$OUT" | cut -f1)"
echo "文件数: $(tar tzf "$OUT" | wc -l)"
echo "MD5: $(md5sum "$OUT" | cut -d' ' -f1)"
