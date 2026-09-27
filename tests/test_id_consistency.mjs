#!/usr/bin/env node
/**
 * HTML ↔ JS 元素一致性测试：防线对应历史事故——
 * set-toast 元素在整文件覆盖时丢失，JS 引用 null 导致设置页逻辑全灭，
 * jsdom 交互测试测不出（不进设置页就不触发），直到用户界面报障。
 *
 * 本测试静态扫描：app.js 中 $("xxx") 引用的元素 id 必须在 index.html 中存在；
 * 反向不强制（HTML 元素允许暂无 JS 绑定）。
 * 运行：node tests/test_id_consistency.mjs（从 app/ 或仓库根均可）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf-8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf-8");

// 提取 HTML 定义的 id
const definedIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

// 提取 JS 引用的 $("id")
const referenced = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

const missing = [...referenced].filter((id) => !definedIds.has(id));

let failed = 0;
if (missing.length) {
  console.error(`[FAIL] app.js 引用但 index.html 未定义的元素 ${missing.length} 个:`);
  for (const id of missing) console.error(`  - ${id}`);
  console.error(`（历史事故：set-toast 丢失导致设置页 TypeError 全灭）`);
  failed = missing.length;
} else {
  console.log(`[PASS] JS 引用的 ${referenced.size} 个元素 id 全部存在于 HTML`);
}

// 命令层对齐：app.js invoke 的命令名必须都在 main.rs 注册
const rustMain = readFileSync(join(root, "app/src-tauri/src/main.rs"), "utf-8");
const invoked = new Set([...js.matchAll(/invoke\("([a-z_]+)"/g)].map((m) => m[1]));
const unregistered = [...invoked].filter(
  (cmd) => !rustMain.includes(`commands::${cmd}`)
);
if (unregistered.length) {
  console.error(`[FAIL] 前端 invoke 但未注册的命令: ${unregistered.join(", ")}`);
  failed += unregistered.length;
} else {
  console.log(`[PASS] 前端调用的 ${invoked.size} 个命令全部已注册`);
}

process.exit(failed ? 1 : 0);
