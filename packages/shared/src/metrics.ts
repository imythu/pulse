// 内置指标名（设计文档 3.2）。Agent 与服务器、前端共用这一份清单。
export const Metric = {
  cpuUsage: 'cpu.usage_pct',
  cpuIowait: 'cpu.iowait_pct',
  load1: 'load.1',
  load5: 'load.5',
  load15: 'load.15',
  memUsed: 'mem.used_pct',
  memUsedBytes: 'mem.used_bytes',
  swapUsed: 'swap.used_pct',
  /** tag = 挂载点 */
  diskUsed: 'disk.used_pct',
  /** tag = 挂载点 */
  diskInodeUsed: 'disk.inode_used_pct',
  diskReadBps: 'disk.read_bps',
  diskWriteBps: 'disk.write_bps',
  netRxBps: 'net.rx_bps',
  netTxBps: 'net.tx_bps',
  tcpEstablished: 'net.tcp_established',
  tcpTimeWait: 'net.tcp_time_wait',
} as const;

export type MetricName = (typeof Metric)[keyof typeof Metric];

export interface MetricMeta {
  label: string;
  unit: 'pct' | 'bytes' | 'bps' | 'count' | 'load';
}

export const METRIC_META: Record<MetricName, MetricMeta> = {
  'cpu.usage_pct': { label: 'CPU 使用率', unit: 'pct' },
  'cpu.iowait_pct': { label: 'CPU iowait', unit: 'pct' },
  'load.1': { label: 'Load 1m', unit: 'load' },
  'load.5': { label: 'Load 5m', unit: 'load' },
  'load.15': { label: 'Load 15m', unit: 'load' },
  'mem.used_pct': { label: '内存使用率', unit: 'pct' },
  'mem.used_bytes': { label: '内存已用', unit: 'bytes' },
  'swap.used_pct': { label: 'Swap 使用率', unit: 'pct' },
  'disk.used_pct': { label: '磁盘使用率', unit: 'pct' },
  'disk.inode_used_pct': { label: 'Inode 使用率', unit: 'pct' },
  'disk.read_bps': { label: '磁盘读', unit: 'bps' },
  'disk.write_bps': { label: '磁盘写', unit: 'bps' },
  'net.rx_bps': { label: '网络入', unit: 'bps' },
  'net.tx_bps': { label: '网络出', unit: 'bps' },
  'net.tcp_established': { label: 'TCP ESTABLISHED', unit: 'count' },
  'net.tcp_time_wait': { label: 'TCP TIME_WAIT', unit: 'count' },
};
