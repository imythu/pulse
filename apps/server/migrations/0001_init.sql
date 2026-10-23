-- M1：用户、会话、Agent 注册、主机与指标。

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE enroll_tokens (
  token_hash text PRIMARY KEY,
  labels     jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  used_by    uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname      text NOT NULL,
  info          jsonb NOT NULL,
  labels        jsonb NOT NULL DEFAULT '{}',
  agent_version text NOT NULL,
  status        text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  last_seen_at  timestamptz,
  last_seq      bigint NOT NULL DEFAULT 0,
  snapshot      jsonb NOT NULL DEFAULT '{}',
  procs         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hosts_labels_idx ON hosts USING gin (labels);

CREATE TABLE agent_credentials (
  host_id    uuid PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- 1 分钟聚合的原始指标，tag 区分同名指标的不同对象（挂载点、网卡等）
CREATE TABLE metrics (
  time    timestamptz NOT NULL,
  host_id uuid NOT NULL,
  name    text NOT NULL,
  tag     text NOT NULL DEFAULT '',
  min     double precision NOT NULL,
  max     double precision NOT NULL,
  avg     double precision NOT NULL,
  p95     double precision NOT NULL
);
SELECT create_hypertable('metrics', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE UNIQUE INDEX metrics_uniq ON metrics (host_id, name, tag, time);

ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host_id, name, tag',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('metrics', INTERVAL '2 days');
SELECT add_retention_policy('metrics', INTERVAL '7 days');

CREATE MATERIALIZED VIEW metrics_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', time) AS bucket,
       host_id, name, tag,
       min(min) AS min, max(max) AS max, avg(avg) AS avg, max(p95) AS p95
FROM metrics
GROUP BY bucket, host_id, name, tag
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1h',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
SELECT add_retention_policy('metrics_1h', INTERVAL '90 days');

CREATE TABLE audit_logs (
  id     bigserial PRIMARY KEY,
  actor  text NOT NULL,
  action text NOT NULL,
  target text,
  detail jsonb NOT NULL DEFAULT '{}',
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);
