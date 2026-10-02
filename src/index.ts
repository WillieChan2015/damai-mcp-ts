/**
 * damai-mcp-ts: Android Emulator MCP for ticket-grabbing automation.
 *
 * 对应 Python `damai_mcp/__init__.py` 的公共面：
 *     __all__ = ["mcp", "main", "__version__"]
 * （`__version__` 在 TS 里以 {@link VERSION} 具名导出。）
 */

export { mcp, VERSION } from "./server";
export { main } from "./cli";

// ---- 本轮新增模块的公共 API（docs/improvements-from-competitors.md §7.1） ----

// 只读余票监控（src/damai/monitor.ts）
export { classifyAvailability, monitorAvailability, MonitorResult } from "./damai/monitor";
export type {
  Availability,
  ClassifyAvailabilityOptions,
  MonitorJudge,
  MonitorOptions,
  MonitorReportCallback,
  MonitorReportSnapshot,
  MonitorResultInit,
  MonitorStopReason,
} from "./damai/monitor";

// 微信 ClawBot 文本通知（src/notify/wechat.ts）
export { ClawBotBodyTooLargeError, ClawBotClient, createFetchTransport } from "./notify/wechat";
export type {
  ClawBotConfig,
  ClawBotRequest,
  ClawBotResponse,
  ClawBotTransport,
  SendOutcome,
  SendStatus,
} from "./notify/wechat";

// 通知凭证本地持久化（src/notify/credentials.ts；0o600/0o700 + rename 原子替换）
export {
  NOTIFY_CREDENTIALS_DIR_DEFAULT,
  NOTIFY_CREDENTIALS_FILE_DEFAULT,
  clearNotifyCredentials,
  loadNotifyCredentials,
  redactToken,
  saveNotifyCredentials,
  setNotifyCredentialsDirForTests,
} from "./notify/credentials";
export type { NotifyCredentials } from "./notify/credentials";

// 设备占用互斥锁（src/device/lock.ts；仅进程内有效）
export { DeviceBusyError, acquireDevice, isDeviceBusy, withDeviceLease } from "./device/lock";
export type { AcquireDeviceOptions, DeviceLease } from "./device/lock";

// ---- 感知与通道提速（工作组 A：item-1 / 2 / 7 / 9） --------------------------

// adb 路径 memo + per-device 持久 shell 复用层（src/device/adb.ts）
export {
  AdbShellClosedError,
  AdbShellTimeoutError,
  PersistentAdbShell,
  clearAdbPathMemo,
  closeAllPersistentShells,
  disablePersistentShellForDevice,
  enablePersistentShellForDevice,
  persistentShellEnabledFor,
  runShellCommand,
} from "./device/adb";
export type { EnablePersistentShellOptions } from "./device/adb";

// dump XML 读取路径 memo（src/inspector/dump.ts）
export { clearDumpReadPathMemo } from "./inspector/dump";

// per-device UI 缓存注册表（src/utils/uiCache.ts）
export {
  UICache,
  disableDeviceUiCache,
  enableDeviceUiCache,
  getDeviceUiCache,
  invalidateDeviceUiCache,
} from "./utils/uiCache";

// 行为随机化原语（src/actions/actions.ts；默认关闭，调用点按需启用）
export { jitterInt, jitteredDelayMs, setJitterRngForTests } from "./actions/actions";
export type { JitterRng } from "./actions/actions";

// ---- 抢票闭环（工作组 C：item-4 / 5 / 6 / 8） --------------------------------

// 抢票阻断词表分类（src/damai/actions.ts；词表在 DamaiSelectors 上可整体覆盖）
export { classifyGrabBlocker } from "./damai/actions";
export type { GrabBlocker, GrabBlockerKind, GrabErrorCategory } from "./damai/actions";
