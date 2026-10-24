# Agent 配置参考

`pulse-agent` 是部署在被监控机器上的探针，单个静态二进制，第一版只支持 **Linux amd64**。配置文件默认位于 `/etc/pulse/agent.yaml`，修改后执行 `systemctl restart pulse-agent` 生效。

## 安装

在控制台点「添加主机」生成一次性注册令牌（默认 24 小时有效），然后在目标机器上执行控制台给出的命令：

```bash
curl -fsSL https://pulse.example.com/install.sh | sudo sh -s -- --token <令牌> [--label env=prod --label service=order-api]
```

脚本会：

1. 下载 Agent 二进制到 `/usr/local/bin/pulse-agent`；
2. 创建系统用户 `pulse`，加入 `adm`、`systemd-journal` 组以读取系统日志；
3. 写入默认配置 `/etc/pulse/agent.yaml`；
4. 用令牌注册：生成 Ed25519 身份密钥，换取 Agent ID，并保存服务器的**指令签名公钥**；
5. 注册 systemd 服务 `pulse-agent`（`MemoryMax=128M`、`CPUQuota=20%`）。

身份文件保存在 `/var/lib/pulse-agent/identity.json`（权限 0600）。需要重新注册时，先删除这个文件。

## 完整配置

```yaml
# 服务器地址，Agent 主动连接，机器不需要开放入站端口
server: https://pulse.example.com
data_dir: /var/lib/pulse-agent

# 主机标签。service=<名称> 用来把主机归到服务，用于 Incident 合并和代码关联
labels:
  env: prod
  service: order-api

# 离线时本地磁盘队列上限，超出后丢弃最旧的消息（默认 100 MB）
queue_max_bytes: 104857600

# 磁盘采集排除的文件系统类型，不写时使用内置列表（tmpfs、overlay、squashfs 等）
ignore_fs_types: []

# ---------- 异常日志 ----------
logs:
  journald:
    enabled: true        # 默认开启
    units: []            # 为空表示全部 unit
    service: ""          # 为空时用 unit 名作为服务名
  files:
    - service: order-api
      paths: [/var/log/order-api/*.log]   # 支持 glob，自动处理轮转和截断
      format: auto       # auto | plain | json | docker
  # 没有明确级别的行命中这些关键字也算异常；为空时用内置列表
  keywords: []

# ---------- 服务版本（AI 分析读取对应提交的代码） ----------
services:
  - name: order-api
    version_file: /opt/order-api/REVISION   # 文件第一行是提交号
  - name: billing
    container: billing                       # 读镜像 label org.opencontainers.image.revision

# ---------- 指令 ----------
commands:
  enabled: true          # false 时拒绝所有指令
  allow: []              # 为空时允许全部只读模板；写操作（svc.restart、risk: write 的自定义模板）必须显式列出
  log_paths: []          # 除 logs.files 外，log.tail / log.grep 还允许读取的文件 glob
  custom: []             # 本机登记的自定义指令，见下文

# 可选：手动指定服务器的指令签名公钥（base64）。不写时用注册时保存的
signing_public_key: ""
```

## 日志采集

Agent 只上报**异常**记录：级别为 ERROR / FATAL / PANIC 等，或没有明确级别但命中关键字（`Exception`、`Traceback`、`panic:`、`segfault`、`timeout` 等）。明确是 INFO / WARN 的行不会因为正文里出现 “timeout” 而被上报。

- **多行合并**：以行首时间戳或级别为分界，把 Java / Python / Go 堆栈合并成一条记录，最多 200 行。
- **上下文**：每条异常携带它之前的若干行普通日志。
- **脱敏**：上报前打码手机号、邮箱、`token=`、`password=`、`Authorization:` 等字段。
- **本地去重**：10 秒窗口内同一个指纹只发首条完整样本和次数。一分钟刷屏 10 万次的同一报错，上报量是 6 条。

`format`：

| 值 | 说明 |
| --- | --- |
| `auto` | 默认。JSON 行按结构化日志解析（`level`、`msg`、`err.stack` 等常见字段），其他按纯文本 |
| `plain` | 只按纯文本处理 |
| `json` | 每行都是 JSON |
| `docker` | Docker json-file 日志驱动的格式（`/var/lib/docker/containers/*/*-json.log`） |

## 服务版本

AI 分析需要知道“这台机器上跑的是哪个仓库的哪个版本”。在 `services` 中为每个服务声明一种读取方式：

- `version_file`：文件第一行是 7–40 位的提交号。可以在发布脚本里 `git rev-parse HEAD > /opt/app/REVISION`。
- `container`：读取容器镜像的 `org.opencontainers.image.revision` label（需要 Agent 能执行 `docker inspect`，把 `pulse` 用户加入 `docker` 组）。

Agent 每分钟读取一次，随心跳上报；版本变化时服务器记一次部署。都读不到时，分析使用仓库默认分支的最新提交，并在报告中标注“版本未确认”。

## 指令

控制台和 AI 分析可以向 Agent 下发**指令模板**补拍现场信息。Agent 不接受任意 shell：

| 模板 | 作用 | 风险 |
| --- | --- | --- |
| `proc.top [by] [n]` | 资源占用最高的进程及命令行 | 只读 |
| `proc.inspect <pid>` | 进程状态、线程数、fd 数、内存映射摘要 | 只读 |
| `log.tail <source> [n]` | 日志末尾 n 行（≤ 2000） | 只读 |
| `log.grep <source> <pattern> [since]` | 按 RE2 正则和时间范围检索，最多 500 行 | 只读 |
| `net.conns` | TCP 连接按状态计数、按远端聚合、监听端口 | 只读 |
| `disk.usage <path> [depth]` | 目录大小排行，不跨文件系统，最多 25 秒 | 只读 |
| `svc.status <unit>` | systemd 服务状态 | 只读 |
| `docker.ps` / `docker.logs <id> [n]` | 容器列表和日志 | 只读 |
| `svc.restart <unit>` | 重启服务 | **写**，需审批且本机 `allow` 显式允许 |

`source` 是文件路径或 `journald:<unit>`。文件必须在 `logs.files` 或 `commands.log_paths` 配置的范围内，符号链接解析后也必须在范围内。

### 安全链路

1. 服务器用独立的 Ed25519 指令签名密钥对 `{ id, hostId, template, args, expiresAt }` 签名。
2. Agent 用注册时保存的公钥验签，检查目标主机是自己、未过期（默认 5 分钟）、ID 没有执行过（执行记录落盘，重启后也防重放）。
3. Agent 按自己内置的模板定义再校验一次参数，检查本机 `commands.allow`。
4. 直接 `exec`，不经过 shell；子进程 `nice 10`，超时杀掉整个进程组；输出上限 1 MB；最多 2 条并发。

即使服务器数据库被篡改，也无法伪造签名；本机配置是最后一道闸，服务器无法突破。

### 自定义指令

在本机登记，模板名为 `custom.<name>`，连接时上报给服务器，控制台的指令终端里可以选择：

```yaml
commands:
  custom:
    - name: queue-depth
      description: 查看指定队列的积压
      risk: read                 # read | write，write 需要审批且要加进 allow
      timeout_seconds: 10        # 默认 30，最长 300
      exec: [/usr/local/bin/queue-stat, --queue, "{queue}"]
      params:
        - name: queue
          label: 队列
          type: string           # string | int | duration | enum
          pattern: "^[a-z0-9-]{1,64}$"   # 字符串参数必须写 pattern
          required: true
```

`exec` 第一项必须是绝对路径；`{参数名}` 在每个参数里整体替换，不会被 shell 解释。

## 资源占用

Agent 常驻内存约 30 MB，平时 CPU 占用低于 1%；每秒 55 条多行报错的日志风暴下约 3%（实测见 [loadtest.md](loadtest.md)）。systemd 单元限制 `MemoryMax=128M`、`CPUQuota=20%`，指令子进程在同一个 cgroup 内。

## 排障

```bash
systemctl status pulse-agent
journalctl -u pulse-agent -f      # JSON 结构化日志
pulse-agent version
```

| 现象 | 原因 |
| --- | --- |
| `连接被拒绝（HTTP 401）` | 凭证被吊销或主机已在控制台删除；需要重新注册 |
| `Agent 时钟偏差超过 5 分钟` | 机器时间不准，配置 NTP |
| 指令都显示“签名无效” | 服务器的签名密钥变了（重建了数据卷）。恢复原来的 `signing.key`，或在配置中写入新的 `signing_public_key` |
| 日志没有上报 | 确认 `pulse` 用户能读日志文件；只有异常级别的记录会上报 |
