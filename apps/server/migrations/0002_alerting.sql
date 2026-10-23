-- M2：日志指纹、规则、告警、Incident 与通知（设计文档 4、9.1）。

CREATE TABLE log_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service         text NOT NULL,
  fingerprint     text NOT NULL,
  level           text NOT NULL CHECK (level IN ('error', 'fatal')),
  template        text NOT NULL,
  first_seen      timestamptz NOT NULL,
  last_seen       timestamptz NOT NULL,
  total_count     bigint NOT NULL DEFAULT 0,
  host_ids        uuid[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ignored', 'resolved')),
  resolved_commit text,
  status_by       text,
  status_at       timestamptz,
  -- 最近一次保存样本的时间，用来限制样本写入频率
  last_sample_at  timestamptz,
  UNIQUE (service, fingerprint)
);
CREATE INDEX log_groups_last_seen_idx ON log_groups (last_seen DESC);
CREATE INDEX log_groups_host_ids_idx ON log_groups USING gin (host_ids);

-- 每个指纹保留首条和最近 20 条样本
CREATE TABLE log_samples (
  id           bigserial PRIMARY KEY,
  log_group_id uuid NOT NULL REFERENCES log_groups(id) ON DELETE CASCADE,
  host_id      uuid REFERENCES hosts(id) ON DELETE SET NULL,
  time         timestamptz NOT NULL,
  source       text NOT NULL,
  message      text NOT NULL,
  context      text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX log_samples_group_idx ON log_samples (log_group_id, id DESC);

-- 指纹每分钟计数，用于突增与扩散检测和计数曲线
CREATE TABLE log_counts (
  time         timestamptz NOT NULL,
  log_group_id uuid NOT NULL,
  host_id      uuid NOT NULL,
  count        bigint NOT NULL
);
SELECT create_hypertable('log_counts', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE UNIQUE INDEX log_counts_uniq ON log_counts (log_group_id, host_id, time);
SELECT add_retention_policy('log_counts', INTERVAL '30 days');

CREATE TABLE rules (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind        text NOT NULL CHECK (kind IN ('threshold', 'disk_fill', 'mem_leak', 'offline', 'log')),
  metric      text,
  params      jsonb NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('warning', 'critical')),
  -- 标签选择器：{"labels": {"env": "prod"}}，为空匹配全部主机
  scope       jsonb NOT NULL DEFAULT '{"labels": {}}',
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO rules (id, name, description, kind, metric, params, severity) VALUES
  ('cpu-high', 'CPU 使用率过高', '超过阈值持续 for 秒后触发；低于恢复阈值持续 recoverFor 秒后恢复；达到 critical 时升级为严重。', 'threshold', 'cpu.usage_pct',
   '{"threshold": 90, "forSeconds": 180, "recover": 80, "recoverForSeconds": 300, "critical": 98}', 'warning'),
  ('mem-high', '内存使用率过高', '按 available 计算的内存使用率。', 'threshold', 'mem.used_pct',
   '{"threshold": 90, "forSeconds": 180, "recover": 85, "recoverForSeconds": 300, "critical": 97}', 'warning'),
  ('disk-high', '磁盘使用率过高', '每个挂载点单独判断。', 'threshold', 'disk.used_pct',
   '{"threshold": 85, "forSeconds": 0, "recover": 80, "recoverForSeconds": 0, "critical": 95}', 'warning'),
  ('inode-high', 'Inode 使用率过高', '每个挂载点单独判断。', 'threshold', 'disk.inode_used_pct',
   '{"threshold": 85, "forSeconds": 0, "recover": 80, "recoverForSeconds": 0, "critical": 95}', 'warning'),
  ('disk-fill', '磁盘即将写满', '按最近 windowHours 小时线性外推，预计 horizonHours 小时内写满时触发，预计超过 recoverHours 小时后恢复。', 'disk_fill', 'disk.used_pct',
   '{"windowHours": 6, "horizonHours": 24, "recoverHours": 48}', 'warning'),
  ('mem-leak', '疑似内存泄漏', '最近 windowHours 小时内存持续上涨（相关系数 ≥ minCorr）且涨幅超过 minIncrease 个百分点。', 'mem_leak', 'mem.used_pct',
   '{"windowHours": 2, "minIncrease": 20, "minCorr": 0.9}', 'warning'),
  ('host-offline', '主机离线', 'Agent 连续 3 次心跳未上报。', 'offline', NULL,
   '{}', 'critical'),
  ('log-error', '异常日志', '新指纹、已解决后复发时触发；5 分钟次数超过 24 小时基线 spikeFactor 倍且不少于 spikeMin 次，或 spreadMinutes 分钟内影响 spreadHosts 台主机时升级；quietMinutes 分钟没有再出现则恢复。', 'log', NULL,
   '{"quietMinutes": 30, "spikeFactor": 5, "spikeMin": 50, "spreadHosts": 3, "spreadMinutes": 10}', 'warning');

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no               bigserial UNIQUE,
  title            text NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('warning', 'critical')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'analyzing', 'resolved')),
  service          text,
  host_ids         uuid[] NOT NULL DEFAULT '{}',
  opened_at        timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  resolved_at      timestamptz,
  last_analysis_id uuid
);
CREATE INDEX incidents_opened_idx ON incidents (opened_at DESC);
CREATE INDEX incidents_open_idx ON incidents (status) WHERE status <> 'resolved';
CREATE INDEX incidents_host_ids_idx ON incidents USING gin (host_ids);

CREATE TABLE alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- (主机, 规则, 对象) 或 (服务, 日志指纹)，同一个键同时只有一个 firing 的告警
  key            text NOT NULL,
  rule_id        text REFERENCES rules(id) ON DELETE SET NULL,
  host_id        uuid REFERENCES hosts(id) ON DELETE CASCADE,
  log_group_id   uuid REFERENCES log_groups(id) ON DELETE CASCADE,
  tag            text NOT NULL DEFAULT '',
  title          text NOT NULL,
  state          text NOT NULL CHECK (state IN ('firing', 'resolved')),
  severity       text NOT NULL CHECK (severity IN ('warning', 'critical')),
  escalated      boolean NOT NULL DEFAULT false,
  reasons        text[] NOT NULL DEFAULT '{}',
  value          double precision,
  peak_value     double precision,
  threshold      double precision,
  count          bigint NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  resolved_at    timestamptz,
  -- 低于恢复阈值的起始时间，满 recoverFor 后恢复
  recover_since  timestamptz,
  -- 最近 1 小时内重新触发的时间点，>= 3 次即为抖动
  flaps          timestamptz[] NOT NULL DEFAULT '{}',
  flapping_until timestamptz,
  incident_id    uuid REFERENCES incidents(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX alerts_firing_key_idx ON alerts (key) WHERE state = 'firing';
CREATE INDEX alerts_key_idx ON alerts (key, resolved_at DESC);
CREATE INDEX alerts_host_idx ON alerts (host_id, started_at DESC);
CREATE INDEX alerts_incident_idx ON alerts (incident_id);

CREATE TABLE incident_events (
  id          bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  type        text NOT NULL,
  alert_id    uuid,
  message     text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX incident_events_incident_idx ON incident_events (incident_id, id);

CREATE TABLE notification_channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('webhook', 'feishu', 'wecom', 'dingtalk', 'slack')),
  url          text NOT NULL,
  secret       text,
  min_severity text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('warning', 'critical')),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
