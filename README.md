# Pulse

自托管的自动化运维监控：机器上的 Agent 采集指标和异常日志，中心服务器去重、聚合成事件，再结合 GitHub 代码仓库用 Claude Agent SDK / Codex SDK 做根因分析。

完整设计见 [docs/design.md](docs/design.md)。

## 当前进度

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 采集与展示 | Agent 注册、指标与进程采集上报、离线补传、主机列表与详情、登录与总览 | 已完成 |
| M2 告警与去重 | 日志采集与指纹、规则引擎、Alert 状态机、Incident 合并、通知 | 已完成（500 Agent 压测未做） |
| M3 指令与仓库 | 签名指令、审批、gh 引导、仓库同步 | 未开始 |
| M4 AI 分析 | Claude / Codex 适配、Pulse MCP 工具、分析报告 | 未开始 |
| M5 自定义脚本与对外 MCP | goja 运行时、脚本发布流程、对外 MCP | 未开始 |

## 目录

```
apps/agent    Go Agent（pulse-agent）
apps/server   TypeScript 后端（Fastify + PostgreSQL/TimescaleDB）
apps/web      React 前端（Vite + Tailwind + React Bits）
packages/shared  前后端与 Agent 协议共用的类型和 Zod schema
deploy/       install.sh、Dockerfile、docker-compose.yml
docs/         设计文档
```

## 本地开发

依赖：Node.js 22.15+（需要内置 zstd）、pnpm、Go 1.25+、带 TimescaleDB 扩展的 PostgreSQL 16。

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # 按需修改 DATABASE_URL
pnpm db:migrate
pnpm --filter @pulse/server dev                # http://127.0.0.1:8080
pnpm --filter @pulse/web dev                   # http://127.0.0.1:5173，/api 代理到后端
```

首次打开会进入初始化页面，创建第一个管理员。

### 在本机跑一个 Agent

```bash
cd apps/agent && make build
# 控制台“添加主机”生成令牌后：
cat > /tmp/agent.yaml <<EOF
server: http://127.0.0.1:8080
data_dir: /tmp/pulse-agent
EOF
./bin/pulse-agent-linux-amd64 enroll --config /tmp/agent.yaml --token <令牌>
./bin/pulse-agent-linux-amd64 run --config /tmp/agent.yaml
```

### 采集应用日志

Agent 默认读取 journald 中的异常日志。应用写文件的日志在 `/etc/pulse/agent.yaml` 中添加：

```yaml
logs:
  files:
    - service: order-api
      paths: [/var/log/order-api/*.log]
      format: auto        # auto | plain | json | docker
```

只上报 ERROR / FATAL 级别或命中关键字（Exception、Traceback、OOM、timeout 等）的记录，多行堆栈自动合并，上报前打码手机号、邮箱和密钥。

生产环境直接在目标机器执行控制台给出的 `curl … /install.sh | sudo sh -s -- --token …`，脚本会安装二进制、创建 `pulse` 用户和 systemd 服务。

## 测试

```bash
pnpm --filter @pulse/server test       # 设置 TEST_DATABASE_URL 后会额外运行网关集成测试（会清空该库）
cd apps/agent && go test ./...          # 含与 TS 共用的指纹用例 packages/shared/fingerprint/cases.json
pnpm typecheck
```

## 部署

```bash
cd deploy
PULSE_PUBLIC_URL=https://pulse.example.com docker compose up -d
```

镜像同时包含后端、前端和 amd64 / arm64 的 Agent 二进制。
