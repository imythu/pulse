import type { HostDetail, HostSummary, Me, MetricsResponse, OverviewStats } from '@pulse/shared';
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api';
import { live, useLive } from './live';

export const keys = {
  me: ['me'] as const,
  setup: ['setup'] as const,
  overview: ['overview'] as const,
  hosts: ['hosts'] as const,
  host: (id: string) => ['host', id] as const,
  metrics: (id: string, rangeMs: number) => ['metrics', id, rangeMs] as const,
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

function upsertHost(qc: QueryClient, host: HostSummary) {
  qc.setQueryData<HostSummary[]>(keys.hosts, (list) => {
    if (!list) return list;
    const i = list.findIndex((h) => h.id === host.id);
    if (i < 0) return [...list, host].sort((a, b) => a.hostname.localeCompare(b.hostname));
    const next = list.slice();
    next[i] = host;
    return next;
  });
  qc.setQueryData<HostDetail>(keys.host(host.id), (d) => (d ? { ...d, ...host } : d));
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
    }
  });
  // 实时连接断开又恢复后，断线期间可能错过事件，全量重拉一次
  useEffect(() => {
    const off = live.onReconnect(() => void qc.invalidateQueries());
    return () => void off();
  }, [qc]);
}
