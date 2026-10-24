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
3. **合并前跑统一验证关卡**（全部通过才可合并）：
   ```bash
   bash tests/run_all.sh          # 五段全量：锁纪律→一致性+死按钮→点击链×5→Rust 全量→release
   bash tests/run_all.sh --fast   # 日常迭代（跳过 release 编译）
   ```
   关卡规则与覆盖矩阵详见 [docs/TESTING.md](docs/TESTING.md)——
   **mock-only ≠ 验收**：新命令必须真路径测试，新按钮必须点击链测试，
   存储函数必须真 SQLite 测试。
4. **合并**：`git checkout main && git merge feat/xxx`（保留分支历史用 --no-ff）
5. **发版**：合并后打 tag `git tag vX.Y.Z && git push origin main --tags`
6. **tag 即发布**：CI 自动构建双平台 Release——tag 必须指向验证通过的合并点

### 约定

- 分支命名：`feat/send-drafts`、`fix/login-timeout`、`test/icon-regression`
- 一个分支一件事；混合改动拆多个分支
- tag 版本号与 app/src-tauri/tauri.conf.json 对齐（CI 会自动同步）

## 关于 AI 开发

本仓库全部代码由 AI agent 编写。若你想贡献：

- 人类贡献同样欢迎，走相同的分支/验证流程
- 提交信息会标注生成方式（AI 直产 / 人工）
- 对 AI 生成代码的质疑/修正是高价值贡献
