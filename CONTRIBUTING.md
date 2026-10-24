# 参与 Pulse

感谢关注。项目处于早期阶段，大的改动请先开 Issue 讨论方向。

## 开发环境

见 [README](README.md#本地开发)。提交前请确保：

```bash
pnpm typecheck
TEST_DATABASE_URL=postgres://... pnpm --filter @pulse/server test
cd apps/agent && go vet ./... && go test ./...
```

## 约定

- **协议与类型**放在 `packages/shared`。修改 Agent 协议时同步更新 `apps/agent/internal/protocol`。
- **指纹规则和指令模板**由 TS 与 Go 共用：修改 `packages/shared/fingerprint` 或 `packages/shared/commands` 后执行 `make -C apps/agent rules`，两边的测试都会校验一致性。
- **数据库迁移**只追加新文件（`apps/server/migrations/NNNN_*.sql`），不要修改已发布的迁移。
- **新增指令模板**必须同时在服务器和 Agent 两侧校验参数；写操作标记 `risk: "write"`，默认需要审批。
- 用户可见文案为中文。错误信息说明“为什么”和“怎么办”。

## 提交

- 一个 PR 解决一件事，附上测试或手工验证步骤。
- 提交即表示你同意以 [AGPL-3.0](LICENSE) 授权你的贡献。
