/**
 * Python `asyncio.Event` 的最小结构等价物。
 *
 * 结构兼容 core 的 `StopEvent` 接口（`src/damai/checklist.ts:334`：
 * `{ readonly isSet: () => boolean }`），可直接作为 `stopEvent` 传给
 * `runChecklist` / `monitorAvailability` / `damaiGrab` 链路。
 */
export class SimpleStopEvent {
  private flag = false;
  private readonly listeners = new Set<() => void>();

  isSet(): boolean {
    return this.flag;
  }

  set(): void {
    if (this.flag) {
      return;
    }
    this.flag = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const fn of listeners) {
      fn();
    }
  }

  /** 等待置位（供需要中断等待的场景与测试使用）。 */
  wait(): Promise<void> {
    if (this.flag) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.listeners.add(resolve);
    });
  }
}
