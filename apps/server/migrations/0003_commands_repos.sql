-- M3：指令、GitHub 仓库、服务与版本关联（设计文档 3.5、7、9.1）。

-- Agent 本地配置的自定义指令模板，在 hello 中上报
ALTER TABLE hosts ADD COLUMN commands jsonb NOT NULL DEFAULT '[]';

CREATE TABLE commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no              bigserial UNIQUE,
  host_id         uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  template        text NOT NULL,
  args            jsonb NOT NULL DEFAULT '{}',
  risk            text NOT NULL CHECK (risk IN ('read', 'write')),
  reason          text NOT NULL DEFAULT '',
  -- user:<id> / analysis:<id>
  requested_by    text NOT NULL,
  approval_status text NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none', 'pending', 'approved', 'rejected')),
  approved_by     text,
  approved_at     timestamptz,
  -- 只有一位 admin 时允许自审，审计中标记
  self_approved   boolean NOT NULL DEFAULT false,
  reject_reason   text,
  status          text NOT NULL CHECK (status IN ('pending_approval', 'queued', 'sent', 'running', 'succeeded', 'failed', 'timeout', 'rejected', 'canceled', 'expired')),
  timeout_seconds int NOT NULL,
  exit_code       int,
  output          text NOT NULL DEFAULT '',
  truncated       boolean NOT NULL DEFAULT false,
  error           text NOT NULL DEFAULT '',
  duration_ms     int,
  incident_id     uuid REFERENCES incidents(id) ON DELETE SET NULL,
  analysis_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  sent_at         timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX commands_host_idx ON commands (host_id, no DESC);
CREATE INDEX commands_active_idx ON commands (status) WHERE status IN ('pending_approval', 'queued', 'sent', 'running');
CREATE INDEX commands_analysis_idx ON commands (analysis_id) WHERE analysis_id IS NOT NULL;

-- 键值设置：gh 检测结果、AI 设置等
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      text NOT NULL UNIQUE,
  default_branch text NOT NULL,
  is_private     boolean NOT NULL DEFAULT false,
  local_path     text NOT NULL,
  status         text NOT NULL DEFAULT 'cloning' CHECK (status IN ('cloning', 'ready', 'error')),
  last_error     text,
  head_commit    text,
  size_bytes     bigint,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- 服务 → 仓库 + 子目录（支持 monorepo）
CREATE TABLE service_bindings (
  service    text PRIMARY KEY,
  repo_id    uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  subdir     text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 每台主机上每个服务的当前版本，变化时记一次部署
CREATE TABLE service_versions (
  service    text NOT NULL,
  host_id    uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  commit     text NOT NULL,
  source     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, host_id)
);

CREATE TABLE deploys (
  id              bigserial PRIMARY KEY,
  service         text NOT NULL,
  host_id         uuid REFERENCES hosts(id) ON DELETE CASCADE,
  commit          text NOT NULL,
  previous_commit text,
  source          text NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deploys_service_idx ON deploys (service, detected_at DESC);
