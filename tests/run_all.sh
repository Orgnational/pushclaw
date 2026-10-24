#!/bin/bash
# PushClaw 全量验证关卡——任何 UI/命令/存储改动后、发版前必须全绿。
# 用法：
#   bash tests/run_all.sh         全量（含 release 编译，发版用）
#   bash tests/run_all.sh --fast  日常迭代（跳过 release 编译）
# 规则详见 docs/TESTING.md。
#
# 关卡自身的红线：任何一段失败必须非零退出。
# bash + pipefail：jsdom/cargo 的失败退出码不允许被管道吞掉
# （历史缺陷：`cargo test | grep || true` 与 `node t | tail` 都会漏过失败）。
set -euo pipefail
cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

echo "===== 1/5 锁纪律静态防线 ====="
python3 tests/test_lock_discipline.py

echo "===== 2/5 前端一致性（id 对齐 + 命令注册 + 死按钮扫描）====="
node tests/test_id_consistency.mjs

echo "===== 3/5 jsdom 点击链 ×5 ====="
for t in test_ui_logic test_login_jump test_settings_display test_send_button test_ui_clicks; do
  node "tests/$t.mjs"
done

echo "===== 4/5 Rust 全量（单元+集成+真路径）====="
(cd app/src-tauri && cargo test --quiet)

if [ "$FAST" = "1" ]; then
  echo ""
  echo "快速关卡通过 ✓（跳过 release 编译——发版前请跑全量）"
  exit 0
fi

echo "===== 5/5 产物可编译（release）====="
(cd app/src-tauri && cargo build --release)

echo ""
echo "全量关卡通过 ✓"
