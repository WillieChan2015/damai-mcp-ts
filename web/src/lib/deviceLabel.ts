/** 下拉框和设备卡片用的设备身份。型号代码仍留在 `model`。 */
export interface DeviceIdentity {
  deviceId: string;
  /** ro.product.model，如 `24129PN74C`。 */
  model?: string;
  /** ro.product.marketname，如 `Xiaomi 15`。 */
  marketName?: string;
  /** persist.sys.device_name，用户在系统设置里起的名字。 */
  deviceName?: string;
}

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * 用户能认出的机型名。
 * 有市场名且和市场代码不同时用市场名，否则退回型号代码。
 */
export function deviceModelLabel(d: DeviceIdentity): string {
  const market = trim(d.marketName);
  const model = trim(d.model);
  if (market !== "" && market !== model) {
    return market;
  }
  return model;
}

/**
 * 设备下拉文案。
 * 有市场名时写成「Xiaomi 15（Willie的Xiaomi 15）」；没有自设名称时括号里是序列号。
 * 没有市场名时保持「序列号（型号代码）」。
 */
export function deviceChoiceLabel(d: DeviceIdentity): string {
  const model = trim(d.model);
  const modelLabel = deviceModelLabel(d);
  const custom = trim(d.deviceName);
  const hasMarketName = modelLabel !== "" && modelLabel !== model;
  if (!hasMarketName) {
    return model !== "" ? `${d.deviceId}（${model}）` : d.deviceId;
  }
  const extra = custom !== "" && custom !== modelLabel ? custom : d.deviceId;
  return extra !== modelLabel ? `${modelLabel}（${extra}）` : modelLabel;
}
