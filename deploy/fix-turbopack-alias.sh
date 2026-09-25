#!/usr/bin/env bash
# 修复 Turbopack(Next 16) 的 serverExternalPackages 哈希别名在 Windows 构建下丢失的问题。
#
# 背景：
#   Next 16 用 Turbopack 构建时，serverExternalPackages 里的包不再直接 require('@prisma/client')，
#   而是 require('@prisma/client-<hash>')，对应目录：
#       .next/node_modules/@prisma/client-<hash>   ->  软链到  node_modules/@prisma/client
#   在 Windows 上构建 standalone 时这个软链**只留下一个空目录**（实测 symlink=false / 0 文件），
#   于是产物上传到 Linux 后别名解析失败：
#       Error: Failed to load external module @prisma/client-<hash>:
#              Cannot find module '@prisma/client-<hash>'   → 所有走数据库的页面/接口 500
#
# 做法：扫描 .next/node_modules/@<scope>/<pkg>-<hash> 下的**空目录**，
#       按 `${name%-*}` 还原真实包名，重建为指向 node_modules/@<scope>/<pkg> 的软链
#       （与本地构建机上的拓扑一致，Node 会 realpath 到真实包，从而正确解析 .prisma/client）。
#
# 幂等：只处理空目录；真实包不存在时跳过并报警。
set -uo pipefail

APP=/home/ubuntu/app
PORT_LOCAL=8080
cd "$APP" || { echo "FATAL: $APP 不存在"; exit 1; }

echo "=== [1/3] 修复哈希别名软链 ==="
FIXED=0
if [ -d .next/node_modules ]; then
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    if [ -n "$(ls -A "$d" 2>/dev/null)" ]; then
      continue
    fi
    scope="$(basename "$(dirname "$d")")"
    name="$(basename "$d")"
    real="${name%-*}"
    target="$APP/node_modules/$scope/$real"
    if [ -d "$target" ]; then
      rm -rf "$d"
      ln -s "$target" "$d"
      echo "  FIXED: $d -> $target"
      FIXED=$((FIXED + 1))
    else
      echo "  SKIP : $d （真实包不存在：$target）"
    fi
  done < <(find .next/node_modules -mindepth 2 -maxdepth 2 -type d 2>/dev/null)
fi
echo "  共修复 $FIXED 个别名"
echo "--- 修复后校验 ---"
find .next/node_modules -mindepth 2 -maxdepth 2 -type l -printf '  %p -> %l\n' 2>/dev/null || true
for d in $(find .next/node_modules -mindepth 2 -maxdepth 2 -type d 2>/dev/null); do
  echo "  [仍为空目录] $d  ($(ls -A "$d" | wc -l) 项)"
done

echo "=== [2/3] 重启服务 ==="
sudo systemctl restart ashare.service
sleep 8
systemctl is-active ashare.service

echo "=== [3/3] 健康检查 ==="
for p in / /simtrade /backtest /stocks /indices /api/simtrade /api/market /api/indices /api/stocks; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:${PORT_LOCAL}${p}" || echo 000)"
  printf '  %s  %s\n' "$code" "$p"
done

echo "--- 若仍有 500，看最近日志 ---"
tail -15 "$APP/app.log" 2>/dev/null || echo "(无 app.log)"
