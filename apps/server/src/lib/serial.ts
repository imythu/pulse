/**
 * 把异步任务串行执行。告警状态机和 Incident 合并都经过它，避免并发上报产生竞态（设计文档 4.3）。
 * 单进程部署足够；拆分多进程时换成按 Alert 键加 Redis 锁。
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** 等待已排队的任务全部完成（测试和关闭时用）。 */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
