import { EventEmitter } from 'node:events';
import type { LiveEvent } from '@pulse/shared';

/**
 * 进程内的实时事件总线。M1 单进程部署足够；拆分多进程时（设计文档 5.3）
 * 换成 Redis Pub/Sub，publish / subscribe 的接口保持不变。
 */
export class LiveBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: LiveEvent): void {
    this.emitter.emit(event.channel, event);
  }

  subscribe(channel: string, listener: (event: LiveEvent) => void): () => void {
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
