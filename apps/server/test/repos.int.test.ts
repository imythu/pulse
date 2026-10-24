// 仓库集成测试（设计文档 7）：需要 TEST_DATABASE_URL（会清空数据）和 git。
// 用一个假的 gh 脚本模拟 GitHub：未登录 → 登录 → 配置 git 凭据 → 选仓库 → 部分克隆 → 按部署版本建只读工作区。
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, mkdirSync, statSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AvailableRepo, GhStatus, RepoInfo, ServiceInfo } from '@pulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { migrationsDir } from '../src/db/paths.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('GitHub 仓库', () => {
  let sql: Sql;
  let app: App;
  let cookie = '';
  const root = mkdtempSync(join(tmpdir(), 'pulse-repos-'));
  const origin = join(root, 'origin.git');
  const state = join(root, 'gh-state');
  const commits: string[] = [];

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const api = async <T>(method: string, path: string, payload?: object) => {
    const res = await app.app.inject({ method: method as 'GET', url: path, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() as T };
  };

  beforeAll(async () => {
    // git 的全局配置写到临时 HOME，不碰开发机
    process.env.HOME = root;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const work = join(root, 'work');
    mkdirSync(join(work, 'services/shop'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main', work);
    git(work, 'config', 'user.email', 't@example.com');
    git(work, 'config', 'user.name', 'tester');
    writeFileSync(join(work, 'services/shop/app.js'), 'const v = 1;\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'first');
    commits.push(git(work, 'rev-parse', 'HEAD'));
    writeFileSync(join(work, 'services/shop/app.js'), 'const v = 2; // null check removed\n');
    git(work, 'commit', '-q', '-am', 'second');
    commits.push(git(work, 'rev-parse', 'HEAD'));
    git(root, 'clone', '-q', '--bare', work, origin);
    git(origin, 'config', 'uploadpack.allowFilter', 'true');

    mkdirSync(state);
    const gh = join(root, 'gh');
    writeFileSync(
      gh,
      `#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2.80.0 (2026-01-01)" ;;
  "auth status")
    if [ -f "${state}/loggedin" ]; then
      printf 'github.com\\n  ✓ Logged in to github.com account octo (keyring)\\n  - Token scopes: %s\\n' "'repo', 'read:org'"
    else
      echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1
    fi ;;
  "auth setup-git") git config --global credential.https://github.com.helper "!${gh} auth git-credential" ;;
  "api user") echo octo ;;
  "api user/orgs") echo acme ;;
  "repo list") echo '[{"nameWithOwner":"acme/shop","defaultBranchRef":{"name":"main"},"isPrivate":true,"description":"商城","pushedAt":"2026-10-20T00:00:00Z","diskUsage":120}]' ;;
  "repo view")
    [ "$3" = "acme/shop" ] || { echo "GraphQL: Could not resolve to a Repository" >&2; exit 1; }
    echo '{"nameWithOwner":"acme/shop","defaultBranchRef":{"name":"main"},"isPrivate":true,"diskUsage":120}' ;;
  "repo clone") dest="$4"; shift 5; exec git clone "$@" "${origin}" "$dest" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(gh, 0o755);

    sql = createDb(url!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql, migrationsDir());
    app = await buildApp(loadConfig({ DATABASE_URL: url!, PULSE_DATA_DIR: join(root, 'data'), PULSE_GH_BIN: gh }), sql, { logger: false });
    const res = await app.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'admin', password: 'admin-password-1' } });
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
  });

  afterAll(async () => {
    await app?.app.close();
    await sql?.end();
  });

  it('引导：未登录 → 已登录 → 配置 git 凭据，每一步给出命令和原因', async () => {
    let s = (await api<GhStatus>('GET', '/api/v1/repos/gh-status?refresh=1')).body;
    expect(s).toMatchObject({ installed: true, version: '2.80.0', loggedIn: false });
    expect(s.problem).toMatch(/未登录/);
    expect(s.steps[1]!.command).toBe(`${join(root, 'gh')} auth status --hostname github.com`);

    writeFileSync(join(state, 'loggedin'), '');
    s = (await api<GhStatus>('GET', '/api/v1/repos/gh-status?refresh=1')).body;
    expect(s).toMatchObject({ loggedIn: true, account: 'octo', tokenSource: 'keyring', gitConfigured: false });
    expect(s.problem).toMatch(/git 凭据/);

    expect((await api<{ ok: boolean }>('POST', '/api/v1/repos/gh-setup-git')).body.ok).toBe(true);
    s = (await api<GhStatus>('GET', '/api/v1/repos/gh-status?refresh=1')).body;
    expect(s).toMatchObject({ gitConfigured: true, problem: null });
    // 不带 refresh 时返回上次检测结果
    expect((await api<GhStatus>('GET', '/api/v1/repos/gh-status')).body.checkedAt).toBe(s.checkedAt);
  });

  it('选择并部分克隆仓库，绑定服务', async () => {
    expect((await api<{ items: string[] }>('GET', '/api/v1/repos/owners')).body.items).toEqual(['octo', 'acme']);
    const avail = (await api<{ items: AvailableRepo[] }>('GET', '/api/v1/repos/available?owner=acme')).body.items;
    expect(avail).toEqual([expect.objectContaining({ fullName: 'acme/shop', isPrivate: true, bound: false })]);

    const missing = await api<{ message: string }>('POST', '/api/v1/repos', { fullName: 'acme/nope' });
    expect(missing.status).toBe(502);
    expect(missing.body.message).toMatch(/不存在/);

    const added = await api<RepoInfo>('POST', '/api/v1/repos', { fullName: 'acme/shop' });
    expect(added.body.status).toBe('cloning');
    for (let i = 0; i < 100; i++) {
      const list = (await api<{ items: RepoInfo[] }>('GET', '/api/v1/repos')).body.items;
      if (list[0]?.status !== 'cloning') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const [repo] = (await api<{ items: RepoInfo[] }>('GET', '/api/v1/repos')).body.items;
    expect(repo).toMatchObject({ status: 'ready', headCommit: commits[1] });
    expect(readFileSync(join(root, 'data/repos/acme/shop/.git/config'), 'utf8')).toMatch(/partialclonefilter = blob:none/);
    expect((await api('POST', '/api/v1/repos', { fullName: 'acme/shop' })).status).toBe(409);

    expect((await api('PUT', '/api/v1/services/shop/binding', { repoId: repo!.id, subdir: 'services/shop' })).status).toBe(200);
    expect((await api('PUT', '/api/v1/services/shop/binding', { repoId: repo!.id, subdir: '../etc' })).status).toBe(400);
    const commitsRes = await api<{ items: { sha: string; subject: string }[] }>('GET', `/api/v1/repos/${repo!.id}/commits`);
    expect(commitsRes.body.items.map((c) => c.subject)).toEqual(['second', 'first']);
  });

  it('Agent 上报版本即记部署；按部署版本建只读工作区', async () => {
    const [h] = await sql<{ id: string }[]>`
      INSERT INTO hosts (hostname, info, labels, agent_version) VALUES ('shop-01', '{}', '{"service":"shop"}', 'test') RETURNING id`;
    await app.services.recordVersions(h!.id, [{ service: 'shop', commit: commits[0]!, source: 'file:/opt/shop/REVISION' }]);
    await app.services.recordVersions(h!.id, [{ service: 'shop', commit: commits[0]!, source: 'file:/opt/shop/REVISION' }]);
    await app.services.recordVersions(h!.id, [{ service: 'shop', commit: 'not-a-sha', source: 'file:x' }]);
    const svc = (await api<{ items: ServiceInfo[] }>('GET', '/api/v1/services')).body.items.find((s) => s.name === 'shop');
    expect(svc).toMatchObject({ hostCount: 1, binding: { fullName: 'acme/shop', subdir: 'services/shop' }, versions: [{ hostname: 'shop-01', commit: commits[0] }] });
    expect((await api<{ items: unknown[] }>('GET', '/api/v1/services/shop/deploys')).body.items).toHaveLength(1);

    const cur = await app.services.currentCommit('shop', h!.id);
    expect(cur).toMatchObject({ commit: commits[0], confirmed: true });
    const ws = await app.repos.workspace(cur.binding!.repoId, cur.commit, cur.binding!.subdir);
    expect(ws).toMatchObject({ commit: commits[0], confirmed: true });
    expect(readFileSync(join(ws.path, 'app.js'), 'utf8')).toBe('const v = 1;\n');
    // 以 root 运行时 access 总是可写，直接看权限位
    expect(statSync(join(ws.path, 'app.js')).mode & 0o222).toBe(0);
    expect(statSync(ws.path).mode & 0o222).toBe(0);
    const diff = await app.repos.diff(cur.binding!.repoId, commits[0]!, commits[1]!, 'services/shop');
    expect(diff.patch).toContain('+const v = 2; // null check removed');
    await ws.cleanup();
    expect(() => accessSync(ws.path)).toThrow();

    // 版本未知：退回默认分支最新提交，标注未确认
    const fallback = await app.repos.workspace(cur.binding!.repoId, 'deadbeefdeadbeef');
    expect(fallback).toMatchObject({ commit: commits[1], confirmed: false });
    await fallback.cleanup();
  });
});
