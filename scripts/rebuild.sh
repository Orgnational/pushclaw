#!/bin/zsh
# PushClaw 一条龙：验证 → 构建 → 安装 → 重启（开发者本机用）
set -e
cd "$(dirname "$0")/../app"
export PATH="$HOME/.cargo/bin:$PATH"

echo "[1/4] cargo check + test"
(cd src-tauri && cargo check 2>&1 | tail -1 && cargo test 2>&1 | grep -E "test result" | awk '{s+=$4;f+=$6} END{print "  Rust:", s, "passed", f, "failed"; exit (f>0?1:0)}')

echo "[2/4] jsdom + id 一致性"
(cd .. && /usr/local/bin/node tests/test_id_consistency.mjs)
(cd .. && /usr/local/bin/node tests/test_ui_logic.mjs | tail -1)

echo "[3/4] tauri build"
npx tauri build --bundles app 2>&1 | tail -1

echo "[4/4] 安装并重启"
pkill -f pushclaw-app 2>/dev/null || true
sleep 1
rm -rf /Applications/PushClaw.app
ditto "src-tauri/target/release/bundle/macos/PushClaw.app" /Applications/PushClaw.app
open /Applications/PushClaw.app
sleep 2
pgrep -fl pushclaw-app | head -1 && echo "✓ 全部完成"
