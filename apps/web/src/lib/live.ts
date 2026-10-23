import type { LiveChannel, LiveEvent } from '@pulse/shared';
import { useEffect, useRef, useSyncExternalStore } from 'react';

export type LiveStatus = 'connecting' | 'open' | 'closed';

type Listener = (event: LiveEvent) => void;

/**
 * 全站共用一条实时连接。按频道引用计数订阅，断线后指数退避重连，
 * 重连成功时通知页面全量重拉，保证断线期间的变更不丢（设计文档 9.4）。
 */
class LiveClient {
  private ws?: WebSocket;
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<() => void>();
  private reconnectListeners = new Set<() => void>();
  private attempt = 0;
  private timer?: number;
  private everOpened = false;
  status: LiveStatus = 'closed';
  lastMessageAt: number | null = null;

  start() {
    if (this.ws || this.timer) return;
    this.connect();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l());
  }

  private connect() {
    this.timer = undefined;
    this.setStatus('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/live`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      this.send('subscribe', [...this.listeners.keys()] as LiveChannel[]);
      if (this.everOpened) this.reconnectListeners.forEach((l) => l());
      this.everOpened = true;
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now();
      try {
        const event = JSON.parse(e.data) as LiveEvent;
        this.listeners.get(event.channel)?.forEach((l) => l(event));
      } catch {
        /* 忽略无法解析的消息 */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.setStatus('closed');
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private send(op: 'subscribe' | 'unsubscribe', channels: LiveChannel[]) {
    if (channels.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, channels }));
  }

  subscribe(channel: LiveChannel, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      this.listeners.set(channel, (set = new Set()));
      this.send('subscribe', [channel]);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(channel);
        this.send('unsubscribe', [channel]);
      }
    };
  }

  onStatus(l: () => void) {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  onReconnect(l: () => void) {
    this.reconnectListeners.add(l);
    return () => this.reconnectListeners.delete(l);
  }
}

export const live = new LiveClient();

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (l) => {
      const off = live.onStatus(l);
      return () => void off();
    },
    () => live.status,
  );
}

/** 订阅一个频道。handler 总是使用最新的闭包，不会因为重新渲染而重复订阅。 */
export function useLive(channel: LiveChannel | null, handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!channel) return;
    return live.subscribe(channel, (e) => ref.current(e));
  }, [channel]);
}
