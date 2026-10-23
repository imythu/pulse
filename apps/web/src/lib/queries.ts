import type {
  AlertInfo,
  HostDetail,
  HostSummary,
  IncidentDetail,
  IncidentSummary,
  LogGroupDetail,
  LogGroupSummary,
  Me,
  MetricsResponse,
  NotificationChannel,
  OverviewStats,
  Page,
  RuleInfo,
} from '@pulse/shared';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api';
import { live, useLive } from './live';

export type IncidentFilter = 'open' | 'resolved' | 'all';

export interface LogGroupFilter {
  status: 'active' | 'ignored' | 'resolved' | 'all';
  service?: string;
  hostId?: string;
  q?: string;
}

export const keys = {
  me: ['me'] as const,
  setup: ['setup'] as const,
  overview: ['overview'] as const,
  hosts: ['hosts'] as const,
  host: (id: string) => ['host', id] as const,
  metrics: (id: string, rangeMs: number) => ['metrics', id, rangeMs] as const,
  hostAlerts: (id: string, rangeMs: number) => ['host-alerts', id, rangeMs] as const,
  incidents: (filter: IncidentFilter, hostId?: string) => ['incidents', filter, hostId ?? ''] as const,
  incident: (id: string) => ['incident', id] as const,
  logGroups: (f: LogGroupFilter) => ['log-groups', f] as const,
  logGroup: (id: string) => ['log-group', id] as const,
  rules: ['rules'] as const,
  channels: ['channels'] as const,
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>('/api/v1/me'), retry: false, staleTime: 60_000 });

export const useSetupStatus = () =>
  useQuery({ queryKey: keys.setup, queryFn: () => api.get<{ needsSetup: boolean }>('/api/v1/setup/status'), staleTime: Infinity });

export const useOverview = () =>
  useQuery({ queryKey: keys.overview, queryFn: () => api.get<OverviewStats>('/api/v1/overview'), refetchInterval: 30_000 });

export const useHosts = () =>
  useQuery({ queryKey: keys.hosts, queryFn: async () => (await api.get<{ items: HostSummary[] }>('/api/v1/hosts')).items });

export const useHost = (id: string) => useQuery({ queryKey: keys.host(id), queryFn: () => api.get<HostDetail>(`/api/v1/hosts/${id}`) });

export const useMetrics = (id: string, rangeMs: number) =>
  useQuery({
    queryKey: keys.metrics(id, rangeMs),
    queryFn: () => {
      const to = Date.now();
      return api.get<MetricsResponse>(`/api/v1/hosts/${id}/metrics?from=${to - rangeMs}&to=${to}`);
    },
    placeholderData: keepPreviousData,
    refetchInterval: rangeMs > 6 * 3600_000 ? 5 * 60_000 : 60_000,
  });

export const useHostAlerts = (id: string, rangeMs: number) =>
  useQuery({
    queryKey: keys.hostAlerts(id, rangeMs),
    queryFn: async () => {
      const to = Date.now();
      return (await api.get<{ items: AlertInfo[] }>(`/api/v1/hosts/${id}/alerts?from=${to - rangeMs}&to=${to}`)).items;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const useIncidents = (filter: IncidentFilter, hostId?: string, limit = 50) =>
  useInfiniteQuery({
    queryKey: [...keys.incidents(filter, hostId), limit],
    queryFn: ({ pageParam }) =>
      api.get<Page<IncidentSummary>>(
        `/api/v1/incidents?status=${filter}&limit=${limit}${hostId ? `&hostId=${hostId}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useIncident = (id: string) => useQuery({ queryKey: keys.incident(id), queryFn: () => api.get<IncidentDetail>(`/api/v1/incidents/${id}`) });

export const useLogGroups = (f: LogGroupFilter) =>
  useQuery({
    queryKey: keys.logGroups(f),
    queryFn: () => {
      const qs = new URLSearchParams({ status: f.status });
      if (f.service) qs.set('service', f.service);
      if (f.hostId) qs.set('hostId', f.hostId);
      if (f.q) qs.set('q', f.q);
      return api.get<{ items: LogGroupSummary[]; services: string[] }>(`/api/v1/log-groups?${qs}`);
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const useLogGroup = (id: string) =>
  useQuery({ queryKey: keys.logGroup(id), queryFn: () => api.get<LogGroupDetail>(`/api/v1/log-groups/${id}`), refetchInterval: 60_000 });

export const useRules = () => useQuery({ queryKey: keys.rules, queryFn: async () => (await api.get<{ items: RuleInfo[] }>('/api/v1/rules')).items, staleTime: 60_000 });

export const useChannels = (enabled = true) =>
  useQuery({
    queryKey: keys.channels,
    queryFn: async () => (await api.get<{ items: NotificationChannel[] }>('/api/v1/notification-channels')).items,
    enabled,
  });

function upsertHost(qc: QueryClient, host: HostSummary) {
  qc.setQueryData<HostSummary[]>(keys.hosts, (list) => {
    if (!list) return list;
    const i = list.findIndex((h) => h.id === host.id);
    if (i < 0) return [...list, host].sort((a, b) => a.hostname.localeCompare(b.hostname));
    const next = list.slice();
    // 状态事件里不带告警数，沿用列表里已有的
    next[i] = { ...host, alerts: list[i]!.alerts };
    return next;
  });
  qc.setQueryData<HostDetail>(keys.host(host.id), (d) => (d ? { ...d, ...host, alerts: d.alerts } : d));
}

/** 总览频道的实时事件直接写进查询缓存，页面不需要轮询。 */
export function useOverviewLiveSync() {
  const qc = useQueryClient();
  useLive('overview', (e) => {
    if (e.type === 'host.status' || e.type === 'host.enrolled') {
      upsertHost(qc, e.host);
      void qc.invalidateQueries({ queryKey: keys.overview });
    } else if (e.type === 'host.snapshot') {
      qc.setQueryData<HostSummary[]>(keys.hosts, (list) =>
        list?.map((h) => (h.id === e.hostId ? { ...h, snapshot: e.snapshot, status: 'online', lastSeenAt: Date.now() } : h)),
      );
    } else if (e.type === 'host.alerts') {
      qc.setQueryData<HostSummary[]>(keys.hosts, (list) => list?.map((h) => (h.id === e.hostId ? { ...h, alerts: e.alerts } : h)));
      qc.setQueryData<HostDetail>(keys.host(e.hostId), (d) => (d ? { ...d, alerts: e.alerts } : d));
      void qc.invalidateQueries({ queryKey: ['host-alerts', e.hostId] });
    } else if (e.type === 'incident.changed') {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      void qc.invalidateQueries({ queryKey: keys.incident(e.incident.id) });
      void qc.invalidateQueries({ queryKey: keys.incident(String(e.incident.no)) });
      void qc.invalidateQueries({ queryKey: keys.overview });
    }
  });
  // 实时连接断开又恢复后，断线期间可能错过事件，全量重拉一次
  useEffect(() => {
    const off = live.onReconnect(() => void qc.invalidateQueries());
    return () => void off();
  }, [qc]);
}
