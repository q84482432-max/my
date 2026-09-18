#!/bin/bash
# ============================================================================
# apply-ui-patch.sh — 应用 UI 主题覆盖补丁（零构建覆盖 + 资源指纹更新）
# ----------------------------------------------------------------------------
# 做什么：
#   1) 全量备份 .next（可整体回滚）
#   2) 把 theme-override.css 追加到构建产物 CSS、nav-active.js 追加到 layout chunk
#   3) 更新两个文件的指纹（文件名 hash），以绕过 Next 的 1 年 immutable 缓存
#   4) 同步更新 .next 内所有对旧指纹的引用
# 不做：不重新构建、不改动业务代码、不碰数据库
# 回滚：见脚本末尾提示
# ============================================================================

APP=/home/ubuntu/app
NEXT=$APP/.next
UIDIR=/home/ubuntu/workbuddy-export/ui-design

OLD_CSS_HASH=1f03992f2f77f6cc
NEW_CSS_HASH=7d3a91c05be4f286
OLD_JS_HASH=8ab5865bd888c90e
NEW_JS_HASH=b16f4e28d0a7c593

CSS=$NEXT/static/css/$OLD_CSS_HASH.css
JS=$NEXT/static/chunks/app/layout-$OLD_JS_HASH.js
STAMP=$(date +%Y%m%d-%H%M%S)

fail() { echo "!! 失败：$1"; exit 1; }

# --- 前置检查 ---------------------------------------------------------------
[ -f "$CSS" ] || fail "找不到目标 CSS：$CSS"
[ -f "$JS" ]  || fail "找不到目标 JS chunk：$JS"
[ -f "$UIDIR/theme-override.css" ] || fail "找不到 $UIDIR/theme-override.css"
[ -f "$UIDIR/nav-active.js" ]      || fail "找不到 $UIDIR/nav-active.js"
grep -q "theme-override" "$CSS" && fail "CSS 已打过补丁，避免重复追加"
grep -q "nav-active" "$JS"      && fail "JS 已打过补丁，避免重复追加"
echo "== 0) 前置检查通过 =="

# --- 1) 备份 ----------------------------------------------------------------
cp -a "$NEXT" "$APP/.next.pre-ui-$STAMP" || fail "全量备份失败"
echo "== 1) 全量备份 -> $APP/.next.pre-ui-$STAMP =="

cp -a "$CSS" "$UIDIR/css-backup-$OLD_CSS_HASH.css" || fail "CSS 单独备份失败"
cp -a "$JS"  "$UIDIR/layout-backup-$OLD_JS_HASH.js" || fail "JS 单独备份失败"
echo "   单独备份 -> $UIDIR/css-backup-$OLD_CSS_HASH.css / layout-backup-$OLD_JS_HASH.js"

# --- 2) 追加补丁 ------------------------------------------------------------
cat "$UIDIR/theme-override.css" >> "$CSS" || fail "追加 CSS 失败"
cat "$UIDIR/nav-active.js"     >> "$JS"  || fail "追加 JS 失败"
echo "== 2) 补丁已追加 =="

NODE_BIN=$(command -v node || echo /opt/node/bin/node)
[ -x "$NODE_BIN" ] || fail "找不到 node 可执行文件"
"$NODE_BIN" --check "$JS" || fail "追加后 JS 语法校验不通过，已中止（备份完好）"
echo "   node --check JS 语法 OK"

# --- 3) 更新指纹 ------------------------------------------------------------
mv "$CSS" "$NEXT/static/css/$NEW_CSS_HASH.css"              || fail "CSS 改名失败"
mv "$JS"  "$NEXT/static/chunks/app/layout-$NEW_JS_HASH.js"  || fail "JS 改名失败"
echo "== 3) 指纹已更新：$OLD_CSS_HASH -> $NEW_CSS_HASH / $OLD_JS_HASH -> $NEW_JS_HASH =="

cd "$NEXT" || fail "无法进入 $NEXT"

n=0
while IFS= read -r f; do
  sed -i "s/$OLD_CSS_HASH/$NEW_CSS_HASH/g" "$f" && n=$((n + 1))
done < <(grep -rl --binary-files=without-match "$OLD_CSS_HASH" . 2>/dev/null)
echo "   CSS 指纹引用更新：$n 个文件"

n=0
while IFS= read -r f; do
  sed -i "s/$OLD_JS_HASH/$NEW_JS_HASH/g" "$f" && n=$((n + 1))
done < <(grep -rl --binary-files=without-match "$OLD_JS_HASH" . 2>/dev/null)
echo "   JS  指纹引用更新：$n 个文件"

# --- 4) 校验 ----------------------------------------------------------------
left_css=$(grep -rl --binary-files=without-match "$OLD_CSS_HASH" . 2>/dev/null | wc -l)
left_js=$(grep -rl --binary-files=without-match "$OLD_JS_HASH" . 2>/dev/null | wc -l)
echo "== 4) 残留检查：旧 CSS 指纹 $left_css 处 / 旧 JS 指纹 $left_js 处 =="
[ "$left_css" -eq 0 ] || fail "旧 CSS 指纹仍有残留"
[ "$left_js"  -eq 0 ] || fail "旧 JS 指纹仍有残留"

echo
echo "== 全部完成 =="
echo "回滚方式（二选一）："
echo "  A) 整体回滚：systemctl stop ashare && rm -rf $NEXT && mv $APP/.next.pre-ui-$STAMP $NEXT && systemctl start ashare"
echo "  B) 只回滚补丁：见 $UIDIR/css-backup-$OLD_CSS_HASH.css 与 layout-backup-$OLD_JS_HASH.js"
