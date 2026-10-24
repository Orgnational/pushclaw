#!/usr/bin/env python3
"""锁纪律静态防线（python3 tests/test_lock_discipline.py）

历史事故（两次真实死锁，均为 Rust 临时值存活期陷阱）：
1. v0.14.1 登录回执：`tx.send(*tx.borrow() + 1)`——borrow 的读锁守卫存活到
   语句末，send 内部取写锁 → 同线程读写锁自死锁（登录成功但永不跳转）
2. v0.14.2 设置页：`Ok(AppSettings{ a: m.lock()..., b: m.lock()... })`——
   结构体字面量字段的临时 MutexGuard 存活到整个表达式结束，第二个字段
   同线程递归 lock 同一把非重入锁 → 永久自死锁（设置页凭据空白）

本防线静态扫描，拦截三类模式的新增：
A. 同一语句内 >=2 次同名 .lock()（递归重入风险）
B. .borrow() 作为同语句函数实参（watch send 模式）
C. 锁 guard 绑定后、同一 async 函数内 await 之后 guard 仍被引用（跨 await 持锁）

命中即退出码 1。新增锁代码若触发本防线，请拆分表达式/缩小 guard 作用域。
"""
import re
import sys

FILES = [
    "app/src-tauri/src/commands.rs",
    "app/src-tauri/src/pushover.rs",
    "app/src-tauri/src/main.rs",
    "app/src-tauri/src/store.rs",
    "app/src-tauri/src/lib.rs",
    "app/src-tauri/src/bin/pushclaw.rs",
]

failures = []

# --- A: 同语句内 >=2 次 .lock()（按分号切语句；跳过注释行） ---
for p in FILES:
    src = open(p).read()
    for stmt in re.split(r';\n?', src):
        if stmt.strip().startswith('//'):
            continue
        locks = re.findall(r'(\w[\w.]*?)\.lock\(\)', stmt)
        names = [l.split('.')[-1] for l in locks]
        dup = {n for n in names if names.count(n) >= 2}
        if dup:
            line = src[:src.find(stmt)].count('\n') + 1
            failures.append(f"[A] {p}:{line} 同一语句内对 {sorted(dup)} 多次 .lock() → 递归死锁风险")

# --- B: f(*x.borrow()) 模式 ---
for p in FILES:
    src = open(p).read()
    for m in re.finditer(r'\w+\([^;()]*\w+\.borrow\(\)', src):
        line = src[:m.start()].count('\n') + 1
        failures.append(f"[B] {p}:{line} .borrow() 作为函数实参（读锁守卫存活至语句末）→ 拆成两条语句")

# --- C: guard 绑定后 await 之后再引用（粗筛，人工复核） ---
# 人工核清清单：内容定位（行号会随编辑漂移，不可用行号）
ALLOWLIST_CONTENT = [
    # get_message/delete/archive/history：guard 存活期内无 await，直接构造返回
    "history(state: tauri::State",
    "get_message(state: tauri::State",
    "delete_messages(",
    "archive_messages(",
    # mark_read/mark_all_read：db guard 在独立块内释放，await 在块外
    "mark_read",
    "mark_all_read",
    # re_register：session guard 块内 clone 释放；await 后是重新拿锁
    "re_register",
]
for p in FILES:
    lines = open(p).read().splitlines()
    for i, l in enumerate(lines):
        m = re.match(r'\s*let\s+(?:mut\s+)?(\w+)\s*=\s*[^;]*\.lock\(\)', l)
        if not m:
            continue
        name = m.group(1)
        if '.clone()' in l and name in ("sess", "st", "guard"):
            # clone 绑定：guard 立即释放
            continue
        scope = lines[i + 1:i + 60]
        await_lines = [j for j, s in enumerate(scope, 1) if ".await" in s]
        ref_lines = [j for j, s in enumerate(scope, 1) if re.search(rf"\b{name}\b", s)]
        if await_lines and ref_lines and max(ref_lines) > min(await_lines):
            # 该 guard 绑定行向上的最近函数签名行决定归属
            sig = next((l2.strip() for l2 in reversed(lines[:i]) if "fn " in l2 or "async fn" in l2), "")
            if any(k in sig for k in ALLOWLIST_CONTENT):
                continue
            failures.append(
                f"[C?] {p}:{i+1} guard `{name}` 疑似跨 await 持有（await@+{min(await_lines)}，"
                f"末引用@+{max(ref_lines)}）→ 人工核查或拆块")
            failures[-1] += "\n     （如为 await 后重新拿锁，请把本处加入 ALLOWLIST）"

if failures:
    print("锁纪律防线命中：")
    for f in failures:
        print("  " + f)
    sys.exit(1)
print(f"锁纪律防线通过（扫描 {len(FILES)} 个文件）")
