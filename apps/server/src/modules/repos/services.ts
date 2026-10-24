// 服务、仓库与版本的关联（设计文档 7.3）：主机 → 服务来自标签 service=<name> 或日志源配置，
// 服务 → 仓库由控制台绑定，服务 → 当前提交由 Agent 读取版本文件或容器 label 上报，变化即记一次部署。
import type { DeployInfo, ServiceInfo, ServiceVersion } from '@pulse/shared';
import type { Sql } from '../../db/index.js';
import { audit } from '../auth/index.js';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface ServiceCommit {
  service: string;
  commit: string | null;
  /** 来自 Agent 上报的部署版本；false 表示需要用默认分支代替 */
  confirmed: boolean;
  binding: { repoId: string; fullName: string; subdir: string } | null;
}

export class ServiceRegistry {
  constructor(private readonly sql: Sql) {}

  async recordVersions(hostId: string, versions: ServiceVersion[]): Promise<void> {
    for (const v of versions) {
      const commit = v.commit.trim().toLowerCase();
      if (!SHA_RE.test(commit)) continue;
      const [prev] = await this.sql<{ commit: string }[]>`
        SELECT commit FROM service_versions WHERE service = ${v.service} AND host_id = ${hostId}`;
      if (prev?.commit === commit) {
        await this.sql`UPDATE service_versions SET updated_at = now() WHERE service = ${v.service} AND host_id = ${hostId}`;
        continue;
      }
      await this.sql`
        INSERT INTO service_versions (service, host_id, commit, source) VALUES (${v.service}, ${hostId}, ${commit}, ${v.source})
        ON CONFLICT (service, host_id) DO UPDATE SET commit = excluded.commit, source = excluded.source, updated_at = now()`;
      await this.sql`
        INSERT INTO deploys (service, host_id, commit, previous_commit, source)
        VALUES (${v.service}, ${hostId}, ${commit}, ${prev?.commit ?? null}, ${v.source})`;
    }
  }

  async list(): Promise<ServiceInfo[]> {
    const names = await this.sql<{ name: string; host_count: number }[]>`
      WITH s AS (
        SELECT labels->>'service' AS name, id AS host_id FROM hosts WHERE labels ? 'service'
        UNION SELECT service, host_id FROM service_versions
        UNION SELECT service, NULL FROM log_groups
        UNION SELECT service, NULL FROM service_bindings
      )
      SELECT name, count(DISTINCT host_id)::int AS host_count FROM s WHERE name <> '' GROUP BY name ORDER BY name`;
    const bindings = await this.sql<{ service: string; repo_id: string; full_name: string; subdir: string }[]>`
      SELECT b.service, b.repo_id, r.full_name, b.subdir FROM service_bindings b JOIN repos r ON r.id = b.repo_id`;
    const versions = await this.sql<{ service: string; host_id: string; hostname: string; commit: string; source: string; updated_at: Date }[]>`
      SELECT v.service, v.host_id, h.hostname, v.commit, v.source, v.updated_at
      FROM service_versions v JOIN hosts h ON h.id = v.host_id ORDER BY h.hostname`;
    const deploys = await this.sql<{ service: string; at: Date }[]>`SELECT service, max(detected_at) AS at FROM deploys GROUP BY service`;
    return names.map((n) => {
      const b = bindings.find((x) => x.service === n.name);
      return {
        name: n.name,
        hostCount: n.host_count,
        binding: b ? { repoId: b.repo_id, fullName: b.full_name, subdir: b.subdir } : null,
        versions: versions
          .filter((v) => v.service === n.name)
          .map((v) => ({ hostId: v.host_id, hostname: v.hostname, commit: v.commit, source: v.source, updatedAt: v.updated_at.getTime() })),
        lastDeployAt: deploys.find((d) => d.service === n.name)?.at.getTime() ?? null,
      };
    });
  }

  async bind(service: string, repoId: string, subdir: string, actor: string) {
    await this.sql`
      INSERT INTO service_bindings (service, repo_id, subdir) VALUES (${service}, ${repoId}, ${subdir.replace(/^\/+|\/+$/g, '')})
      ON CONFLICT (service) DO UPDATE SET repo_id = excluded.repo_id, subdir = excluded.subdir, updated_at = now()`;
    await audit(this.sql, actor, 'service.bound', service, { repoId, subdir });
  }

  async unbind(service: string, actor: string) {
    await this.sql`DELETE FROM service_bindings WHERE service = ${service}`;
    await audit(this.sql, actor, 'service.unbound', service);
  }

  async deploys(service: string | null, sinceMs: number, limit = 50): Promise<DeployInfo[]> {
    const rows = await this.sql<
      { id: string; service: string; host_id: string | null; hostname: string | null; commit: string; previous_commit: string | null; source: string; detected_at: Date }[]
    >`
      SELECT d.*, h.hostname FROM deploys d LEFT JOIN hosts h ON h.id = d.host_id
      WHERE d.detected_at >= ${new Date(sinceMs)} ${service ? this.sql`AND d.service = ${service}` : this.sql``}
      ORDER BY d.detected_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: Number(r.id),
      service: r.service,
      hostId: r.host_id,
      hostname: r.hostname,
      commit: r.commit,
      previousCommit: r.previous_commit,
      source: r.source,
      detectedAt: r.detected_at.getTime(),
    }));
  }

  /** 分析用：某个服务在某台主机（或多数主机）上的当前提交与仓库绑定。 */
  async currentCommit(service: string, hostId?: string | null): Promise<ServiceCommit> {
    const [b] = await this.sql<{ repo_id: string; full_name: string; subdir: string }[]>`
      SELECT b.repo_id, r.full_name, b.subdir FROM service_bindings b JOIN repos r ON r.id = b.repo_id WHERE b.service = ${service}`;
    const [v] = await this.sql<{ commit: string }[]>`
      SELECT commit FROM service_versions WHERE service = ${service}
      ORDER BY (host_id = ${hostId ?? null}::uuid) DESC NULLS LAST, updated_at DESC LIMIT 1`;
    return {
      service,
      commit: v?.commit ?? null,
      confirmed: !!v,
      binding: b ? { repoId: b.repo_id, fullName: b.full_name, subdir: b.subdir } : null,
    };
  }
}
