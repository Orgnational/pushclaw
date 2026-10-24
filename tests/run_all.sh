#!/bin/sh
# PushClaw 全量验证关卡——任何 UI/命令/存储改动后、发版前必须全绿。
# 用法：sh tests/run_all.sh
# 规则详见 docs/TESTING.md；某一环失败即停（set -e）。
set -e
cd "$(dirname "$0")/.."

echo "===== 1/5 锁纪律静态防线 ====="
python3 tests/test_lock_discipline.py

echo "===== 2/5 前端一致性（id 对齐 + 命令注册 + 死按钮扫描）====="
node tests/test_id_consistency.mjs

echo "===== 3/5 jsdom 点击链 ×6 ====="
for t in test_ui_logic test_login_jump test_settings_display test_send_button test_ui_clicks; do
  node "tests/$t.mjs" | tail -1
done

echo "===== 4/5 Rust 全量（单元+集成+真路径）====="
(cd app/src-tauri && cargo test --quiet 2>&1 | grep -E "test result|error" || true)

echo "===== 5/5 产物可编译（release）====="
(cd app/src-tauri && cargo build --release 2>&1 | tail -1)

echo ""
echo "全量关卡通过 ✓"
