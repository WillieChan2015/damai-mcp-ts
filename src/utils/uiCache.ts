/**
 * inspector/dump 之上的缓存层（Python `utils/ui_cache.py` 的 TS 对应物）。
 *
 * 背景：
 *   每次 findByText / waitForElement 都会触发一次 `uiautomator dump`，
 *   真机上耗时约 250-350ms。抢票流水线常在同一页面连续做 5 次定位
 *   （buy → price tier → viewer → confirm → submit），不缓存就要白等 5 倍时间。
 *
 * 策略：
 *   取一张小截屏（实际上只取 screencap 的头部字节）并哈希。
 *   若哈希与缓存一致且缓存仍新鲜（TTL 内），直接返回缓存的
 *   {@link UIElement} 列表；否则重新 dump。
 *
 * TTL 默认 1.0s，对亚秒级抓取偏保守；热循环可调低（如 0.2s）。
 */
import { createHash } from "node:crypto";

import { adb } from "../device/adb";
import { dumpUi } from "../inspector/dump";
import type { UIElement } from "../inspector/models";
import { logger } from "./logging";
import { searchElements } from "./findHelpers";

/** 默认 TTL（秒）。 */
export const DEFAULT_TTL_SEC = 1.0;

/** 只取截屏头部的字节数——无需完整 PNG 即可廉价指纹。 */
export const SCREENCAP_HEADER_BYTES = 4096;

/**
 * 手写互斥锁（对应 Python `asyncio.Lock` 的语义）。
 *
 * Promise 链保证同一时刻至多一个调用在临界区内执行，
 * 其余调用按到达顺序排队；临界区抛错会传播给发起者，
 * 但不阻塞后续排队者（等价于 Lock 释放后异常继续上抛）。
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** 在互斥区内执行 `fn`；返回值/异常原样透传给调用方。 */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** {@link UICache.find} 的查找条件；`text` / `resourceId` / `xpath` 至少给出一个。 */
export interface UICacheFindOptions {
  /** 按 text 匹配（exact 时全等，否则子串）。 */
  text?: string | null;
  /** 按 resource-id 匹配（exact 时全等，否则后缀匹配）。 */
  resourceId?: string | null;
  /** 标准 XPath 1.0 表达式；给出时忽略 text / resourceId / exact。 */
  xpath?: string | null;
  /** 是否精确匹配。默认 true。 */
  exact?: boolean;
}

/** 按设备隔离的屏幕状态缓存；两台设备互不共享状态，一台设备一个实例。 */
export class UICache {
  private readonly ttlSec: number;
  private screenHash: string | null = null;
  private fetchedAt = 0;
  private elements: UIElement[] = [];
  private hits = 0;
  private misses = 0;
  private readonly lock = new AsyncMutex();

  constructor(ttlSec: number = DEFAULT_TTL_SEC) {
    this.ttlSec = ttlSec;
  }

  /** 缓存命中/未命中计数快照（用于遥测）。 */
  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /** 强制下一次 {@link get} 重新 dump。 */
  invalidate(): void {
    this.screenHash = null;
    this.fetchedAt = 0;
  }

  /** 对一张小截屏做哈希，廉价探测屏幕是否变化。失败时返回 null。 */
  private async fingerprint(deviceId: string): Promise<string | null> {
    try {
      const result = await adb("exec-out", "screencap", "-p", {
        deviceId,
        timeout: 3.0,
        check: false,
      });
      if (!result.ok || result.stdoutBytes.length === 0) {
        return null;
      }
      // 只取头部 N 字节——PNG 头部对同一布局是稳定的，无需逐像素比较。
      const head = result.stdoutBytes.subarray(0, SCREENCAP_HEADER_BYTES);
      return createHash("md5").update(head).digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * 屏幕未变化时返回缓存的元素。
   *
   * 并发调用经由 asyncio.Lock 语义的互斥锁共享同一次底层 dump。
   */
  async get(deviceId: string): Promise<UIElement[]> {
    return this.lock.runExclusive(async () => {
      const now = performance.now();
      const age = now - this.fetchedAt;
      if (this.screenHash !== null && age < this.ttlSec * 1000) {
        const h = await this.fingerprint(deviceId);
        if (h !== null && h === this.screenHash) {
          this.hits += 1;
          logger.debug(
            `UI 缓存命中: device=${deviceId} 省略 1 次 dump（累计命中 ${this.hits}，未命中 ${this.misses}）`,
          );
          return this.elements;
        }
      }
      this.misses += 1;
      logger.debug(
        `UI 缓存未命中: device=${deviceId} 重新 dump（累计命中 ${this.hits}，未命中 ${this.misses}）`,
      );
      this.elements = await dumpUi(deviceId);
      this.screenHash = await this.fingerprint(deviceId);
      this.fetchedAt = performance.now();
      return this.elements;
    });
  }

  /** 缓存版查找——等价于 find_by_text，但可能完全跳过 dump。 */
  async find(
    deviceId: string,
    {
      text = null,
      resourceId = null,
      xpath: xpathExpr = null,
      exact = true,
    }: UICacheFindOptions = {},
  ): Promise<UIElement | null> {
    const elements = await this.get(deviceId);
    return searchElements(elements, { text, resourceId, xpath: xpathExpr, exact });
  }
}

// ---------------------------------------------------------------------------
// per-device 注册表：抢票热路径（checklist / damaiGrab）显式启用；未注册时
// inspector/find 的 find* 保持裸 dumpUi 的旧行为（机制零参与，逐字一致）。
// 已知盲区：截屏头部指纹对「顶部像素不变、底部弹层出现」可能误判未变——
// 因此写路径（tap/swipe 等）每次成功后必须 invalidateDeviceUiCache；TTL 上限
// 1s 限陈旧度；价格读取（damaiSelectPrice）直调 dumpUi 永不缓存。
// ---------------------------------------------------------------------------

/** deviceId → UICache 实例。 */
const deviceUiCaches = new Map<string, UICache>();

/** 取设备的 UI 缓存实例；未注册时返回 null（调用方回落裸 dumpUi）。 */
export function getDeviceUiCache(deviceId: string): UICache | null {
  return deviceUiCaches.get(deviceId) ?? null;
}

/**
 * 为设备启用 UI 缓存并返回实例；重复启用返回既有实例（TTL 不变）。
 *
 * @param ttlSec 缓存 TTL（秒）。默认 {@link DEFAULT_TTL_SEC}；抢票热循环可
 *   传 0.5 之类更小的值限陈旧度。
 */
export function enableDeviceUiCache(deviceId: string, ttlSec: number = DEFAULT_TTL_SEC): UICache {
  const existing = deviceUiCaches.get(deviceId);
  if (existing !== undefined) {
    return existing;
  }
  const cache = new UICache(ttlSec);
  deviceUiCaches.set(deviceId, cache);
  return cache;
}

/** 停用并丢弃设备的 UI 缓存；未注册时为 no-op。 */
export function disableDeviceUiCache(deviceId: string): void {
  deviceUiCaches.delete(deviceId);
}

/** 强制设备的下一次读取重新 dump；未注册时为 no-op。写路径成功后必须调用。 */
export function invalidateDeviceUiCache(deviceId: string): void {
  deviceUiCaches.get(deviceId)?.invalidate();
}
