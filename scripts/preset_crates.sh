#!/bin/zsh
# 循环预置缺失 crate（从 static.crates.io 直下到 rsproxy 缓存目录）
CACHE=~/.cargo/registry/cache/rsproxy.cn-e3de039b2554c837
mkdir -p $CACHE
cd /Users/orgnational/.zcode/workspace/default/pushclaw/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
for i in 1 2 3 4 5 6 7 8; do
  OUT=$(cargo check 2>&1)
  URL=$(echo "$OUT" | grep -oE 'https://[^ `]+\.crate' | head -1)
  if [ -n "$URL" ]; then
    NAME=$(echo "$URL" | grep -oE '[a-z0-9_-]+/[a-z0-9_.-]+\.crate' | head -1)
    echo "== $i: 预置 $NAME"
    curl -sS -m 30 -o "$CACHE/$NAME" "https://static.crates.io/crates/$NAME" 2>&1
    sleep 2
    continue
  fi
  if echo "$OUT" | grep -qE "Finished"; then
    echo "✓✓ 编译完成"
    break
  fi
  if echo "$OUT" | grep -qE "^error\["; then
    echo "代码错误:"
    echo "$OUT" | grep -E "^error" | head -2
    break
  fi
  echo "== $i: $(echo "$OUT" | tail -1 | head -c 90)"
  sleep 3
done
echo "---- 最终 ----"
cargo check 2>&1 | tail -1
