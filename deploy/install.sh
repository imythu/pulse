#!/bin/sh
# Pulse Agent 安装脚本。由服务器 /install.sh 提供，__PULSE_SERVER__ 会被替换成服务器地址。
# 用法：curl -fsSL <server>/install.sh | sudo sh -s -- --token <注册令牌> [--label key=value ...]
set -eu

SERVER="__PULSE_SERVER__"
TOKEN=""
LABELS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --label) LABELS="$LABELS --label $2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$TOKEN" ] || { echo "缺少 --token" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行（sudo）" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "需要 systemd" >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

echo "==> 下载 pulse-agent ($ARCH)"
TMP="$(mktemp)"
curl -fsSL "$SERVER/downloads/pulse-agent-linux-$ARCH" -o "$TMP"
install -m 0755 "$TMP" /usr/local/bin/pulse-agent
rm -f "$TMP"

echo "==> 创建用户与目录"
id pulse >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pulse
install -d -o pulse -g pulse -m 0750 /var/lib/pulse-agent
install -d -m 0755 /etc/pulse
# adm / systemd-journal 组用于读取系统日志（M2 日志采集）
for g in adm systemd-journal; do getent group "$g" >/dev/null && usermod -a -G "$g" pulse || true; done

if [ ! -f /etc/pulse/agent.yaml ]; then
  cat > /etc/pulse/agent.yaml <<EOF
server: $SERVER
data_dir: /var/lib/pulse-agent
labels: {}
# 异常日志采集：journald 默认开启；应用日志文件按下面的格式添加
# logs:
#   files:
#     - service: order-api
#       paths: [/var/log/order-api/*.log]
#       format: auto        # auto | plain | json | docker
#   journald:
#     enabled: true
#     units: []           # 为空表示全部
EOF
fi

echo "==> 注册到 $SERVER"
# shellcheck disable=SC2086
sudo -u pulse /usr/local/bin/pulse-agent enroll --config /etc/pulse/agent.yaml --token "$TOKEN" $LABELS

cat > /etc/systemd/system/pulse-agent.service <<'EOF'
[Unit]
Description=Pulse monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
User=pulse
Group=pulse
ExecStart=/usr/local/bin/pulse-agent run --config /etc/pulse/agent.yaml
Restart=always
RestartSec=5
MemoryMax=128M
CPUQuota=20%
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/pulse-agent
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pulse-agent
echo "==> 完成。查看状态：systemctl status pulse-agent"
