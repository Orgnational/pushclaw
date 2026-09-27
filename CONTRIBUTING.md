# 贡献与开发流程

## 分支工作流（所有新功能/修复必须遵守）

```
main                ← 始终可发布；只接受经过验证的合并
  └─ feat/xxx       ← 新功能分支（feat/fix/test 前缀）
       └─ 验证四阶段全绿 → 合并 main → 打 tag → CI 出 Release
```

### 规则

1. **开分支**：`git checkout -b feat/<短名>`（修复用 `fix/`，测试用 `test/`）
2. **在分支上开发 + 提交**，禁止直推 main
3. **合并前跑四阶段验证关卡**（全部通过才可合并）：
   ```bash
   cd app/src-tauri && cargo check && cargo test        # ① 构建 ② Rust 测试
   cd .. && node ../tests/test_id_consistency.mjs        # ③ 一致性扫描
   /usr/local/bin/node ../tests/test_ui_logic.mjs        #    jsdom 交互
   npx tauri build --bundles app                         # ④ release 构建
   ```
4. **合并**：`git checkout main && git merge feat/xxx`（保留分支历史用 --no-ff）
5. **发版**：合并后打 tag `git tag vX.Y.Z && git push origin main --tags`
6. **tag 即发布**：CI 自动构建双平台 Release——tag 必须指向验证通过的合并点

### 约定

- 分支命名：`feat/send-drafts`、`fix/login-timeout`、`test/icon-regression`
- 一个分支一件事；混合改动拆多个分支
- tag 版本号与 app/src-tauri/tauri.conf.json 对齐（CI 会自动同步）
