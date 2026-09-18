#!/bin/bash
# ============================================================================
# apply-nav-v2.sh — 更新注入到 layout chunk 的 nav-active 脚本（v1 -> v2）
# ----------------------------------------------------------------------------
# v2 新增：
#   1) /app 前缀归一化：经工作台 /app 入口访问时，"当前页"标记同样正确
#   2) 首页链接改写：代理环境下把 href="/" 的链接（logo、行情中心）改到 /app，
#      避免点击后跳出应用、落到工作台首页
# 做法：用 apply-ui-patch.sh 留下的原始 chunk 备份整体重建 live chunk，
#       追加 v2 脚本；文件名不变（layout-b16f4e28d0a7c593.js），无需更新引用。
# 回滚：UIDIR 下 layout-backup-v1-<时间戳>.js 覆盖回 live 路径即可。
# ============================================================================
set -e

APP=/home/ubuntu/app
NEXT=$APP/.next
UIDIR=/home/ubuntu/workbuddy-export/ui-design
LIVE_JS=$NEXT/static/chunks/app/layout-b16f4e28d0a7c593.js
BACKUP_JS=$UIDIR/layout-backup-8ab5865bd888c90e.js
STAMP=$(date +%Y%m%d-%H%M%S)

fail() { echo "!! 失败：$1"; exit 1; }

[ -f "$BACKUP_JS" ]           || fail "找不到原始 chunk 备份：$BACKUP_JS"
[ -f "$UIDIR/nav-active.js" ] || fail "找不到 $UIDIR/nav-active.js"
grep -q "nav-active.js v2" "$UIDIR/nav-active.js" || fail "nav-active.js 不是 v2 版本"
echo "== 0) 前置检查通过 =="

cp -a "$LIVE_JS" "$UIDIR/layout-backup-v1-$STAMP.js" || fail "v1 chunk 备份失败"
echo "== 1) v1 chunk 备份 -> layout-backup-v1-$STAMP.js =="

TMP_JS="$UIDIR/.na-check-$STAMP.js"
cat "$BACKUP_JS" "$UIDIR/nav-active.js" > "$TMP_JS" || fail "重建失败"
NODE_BIN=$(command -v node || echo /opt/node/bin/node)
[ -x "$NODE_BIN" ] || fail "找不到 node 可执行文件"
"$NODE_BIN" --check "$TMP_JS" || { rm -f "$TMP_JS"; fail "语法校验不通过（原 chunk 未动）"; }
mv "$TMP_JS" "$LIVE_JS" || fail "替换失败"
echo "== 2) v2 脚本已注入，node --check 语法 OK =="
echo "完成。静态文件即时生效，无需重启；浏览器端受 immutable 缓存影响需强刷。"
