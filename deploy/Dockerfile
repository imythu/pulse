# 一个镜像包含：后端、前端构建产物、各架构的 Agent 二进制（供 /install.sh 下载）
FROM golang:1.27 AS agent
WORKDIR /src/apps/agent
COPY apps/agent/go.mod apps/agent/go.sum ./
RUN go mod download
COPY apps/agent ./
COPY packages/shared/fingerprint /src/packages/shared/fingerprint
RUN make build VERSION=$(date +%Y.%m.%d)

FROM node:22-bookworm AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @pulse/web build && pnpm --filter @pulse/server build \
 && pnpm --filter @pulse/server deploy --prod /out/server

FROM node:22-bookworm-slim
# gh 与 git 供仓库集成使用（M3）
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/server ./
COPY --from=build /src/apps/server/dist ./dist
COPY apps/server/migrations ./migrations
COPY deploy/install.sh ./deploy/install.sh
COPY --from=build /src/apps/web/dist ./web
COPY --from=agent /src/apps/agent/bin ./agent
ENV NODE_ENV=production PORT=8080 PULSE_WEB_DIST=/app/web PULSE_AGENT_DIST=/app/agent
EXPOSE 8080
CMD ["node", "dist/main.js"]
