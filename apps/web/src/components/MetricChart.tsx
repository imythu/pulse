import type { MetricSeries } from '@pulse/shared';
import { useEffect, useRef } from 'react';
import { formatMetric } from '@/lib/format';

export interface ChartLine {
  label: string;
  metric: string;
  series: MetricSeries | undefined;
  color: string;
}

/** 告警区间，画成半透明色带 */
export interface ChartBand {
  from: number;
  to: number;
  severity: 'warning' | 'critical';
}

type ECharts = import('echarts/core').ECharts;

/**
 * 时序折线图。同一 group 的图表联动 tooltip；
 * threshold 画出告警阈值参考线，bands 标出告警持续的时间段，让“高不高”有据可依。
 */
export function MetricChart({
  lines,
  group,
  threshold,
  bands,
  max,
  height = 200,
}: {
  lines: ChartLine[];
  group: string;
  threshold?: number;
  bands?: ChartBand[];
  max?: number;
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    void import('@/lib/echarts').then(({ echarts }) => {
      if (disposed || !el.current) return;
      chart.current = echarts.init(el.current, undefined, { renderer: 'canvas' });
      chart.current.group = group;
      echarts.connect(group);
      ro = new ResizeObserver(() => chart.current?.resize());
      ro.observe(el.current);
      render();
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  const render = () => {
    const c = chart.current;
    if (!c) return;
    const metric = lines[0]?.metric ?? '';
    c.setOption(
      {
        animation: false,
        grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
        legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 3, textStyle: { color: '#9aa3b5', fontSize: 11 } },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(13,16,22,0.95)',
          borderColor: 'rgba(255,255,255,0.1)',
          textStyle: { color: '#e7e9ef', fontSize: 12 },
          valueFormatter: (v: unknown) => (typeof v === 'number' ? formatMetric(metric, v) : '—'),
        },
        xAxis: {
          type: 'time',
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
          axisLabel: { color: '#626b7e', fontSize: 11, hideOverlap: true },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          max,
          min: 0,
          axisLabel: { color: '#626b7e', fontSize: 11, formatter: (v: number) => formatMetric(metric, v) },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        },
        series: lines.map((l, i) => ({
          name: l.label,
          type: 'line',
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { width: 1.6, color: l.color },
          itemStyle: { color: l.color },
          areaStyle: i === 0 ? { color: l.color, opacity: 0.08 } : undefined,
          data: l.series?.points.map(([t, avg]) => [t, avg]) ?? [],
          markLine:
            i === 0 && threshold != null
              ? {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { color: '#ef4444', type: 'dashed', opacity: 0.6 },
                  label: { position: 'insideEndTop', color: '#ef4444', fontSize: 10, formatter: `告警阈值 ${threshold}%` },
                  data: [{ yAxis: threshold }],
                }
              : undefined,
          markArea:
            i === 0 && bands?.length
              ? {
                  silent: true,
                  data: bands.map((b) => [
                    { xAxis: b.from, itemStyle: { color: b.severity === 'critical' ? 'rgba(239,68,68,0.10)' : 'rgba(251,191,36,0.10)' } },
                    { xAxis: b.to },
                  ]),
                }
              : undefined,
        })),
      },
      { notMerge: true },
    );
  };

  useEffect(render);

  return <div ref={el} style={{ height }} className="w-full" />;
}
