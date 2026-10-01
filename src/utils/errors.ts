/**
 * damai-mcp 的异常层级（Python `utils/errors.py` 的 TS 对应物）。
 *
 * 捕获基类 {@link DamaiMCPError} 即可覆盖「任何出错」的场景；
 * 具体子类让调用方（以及 MCP 错误响应）能更精确地描述错误。
 */

/** 所有 damai-mcp 错误的基类。 */
export class DamaiMCPError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DamaiMCPError";
    // 兼容经过转译/继承链重建 prototype 的运行环境（Bun/Node 22 原生 class 下是冗余的保险）
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 指定的 device_id 不在 `adb devices` 列表中。 */
export class DeviceNotFoundError extends DamaiMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeviceNotFoundError";
  }
}

/** adb 命令返回非零退出码或产生错误信息。 */
export class ADBError extends DamaiMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ADBError";
  }
}

/** find_by_* 在超时时间内未能定位到请求的元素。 */
export class UIElementNotFoundError extends DamaiMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UIElementNotFoundError";
  }
}

/**
 * 通用等待超时——包装 asyncio.TimeoutError 的语义。
 *
 * 命名保留 Python 版的 `TimeoutError_`（尾随下划线）：
 * Python 里是为了不遮蔽内置 TimeoutError，TS 里相应地避免与
 * Node/DOM 全局 `TimeoutError` 混淆。
 */
export class TimeoutError_ extends DamaiMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TimeoutError_";
  }
}

/** 预期应用不在前台 / 未运行。 */
export class AppNotRunningError extends DamaiMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppNotRunningError";
  }
}

/** 大麦登录会话已过期；需要用户重新扫码。 */
export class DamaiLoginExpiredError extends DamaiMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DamaiLoginExpiredError";
  }
}

/** 无法在重试预算内完成抢票流程。 */
export class DamaiGrabFailedError extends DamaiMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DamaiGrabFailedError";
  }
}
