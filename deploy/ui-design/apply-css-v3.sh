#!/bin/bash
# ============================================================================
# apply-css-v3.sh — 追加第三批 CSS（顶栏数据标签窄屏隐藏）并轮换指纹
# ----------------------------------------------------------------------------
# a4c7f2e91b3d5806 -> c8e2f4a61d903b75
# 回滚：UIDIR/css-backup-a4c7f2e91b3d5806.css 是追加前的完整副本。
# ============================================================================
set -e

APP=/home/ubuntu/app
NEXT=$APP/.next
UIDIR=/home/ubuntu/workbuddy-export/ui-design

OLD=a4c7f2e91b3d5806
NEW=c8e2f4a61d903b75
CSS=$NEXT/static/css/$OLD.css
STAMP=$(date +%Y%m%d-%H%M%S)

fail() { echo "!! 失败：$1"; exit 1; }

[ -f "$CSS" ]                          || fail "找不到当前 CSS：$CSS"
[ -f "$UIDIR/theme-override-v3.css" ]  || fail "找不到 $UIDIR/theme-override-v3.css"
grep -q "1023.9" "$CSS"                && fail "v3 已追加过，避免重复"
echo "== 0) 前置检查通过 =="

cp -a "$CSS" "$UIDIR/css-backup-$OLD.css" || fail "备份失败"
echo "== 1) 备份 -> css-backup-$OLD.css =="

cat "$UIDIR/theme-override-v3.css" >> "$CSS" || fail "追加失败"
echo "== 2) v3 规则已追加 =="

mv "$CSS" "$NEXT/static/css/$NEW.css" || fail "改名失败"
cd "$NEXT" || fail "无法进入 $NEXT"
n=0
while IFS= read -r f; do
  sed -i "s/$OLD/$NEW/g" "$f" && n=$((n + 1))
done < <(grep -rl --binary-files=without-match "$OLD" . 2>/dev/null)
echo "== 3) 指纹 $OLD -> $NEW，引用更新 $n 个文件 =="

left=$(grep -rl --binary-files=without-match "$OLD" . 2>/dev/null | wc -l)
[ "$left" -eq 0 ] || fail "旧指纹仍有 $left 处残留"
echo "== 4) 残留检查通过 =="
echo "完成。随后重启 ashare 清掉预渲染缓存：sudo systemctl restart ashare"
