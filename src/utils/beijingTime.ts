/**
 * 开票与监控时间按北京时间（UTC+8，无夏令时）解释墙钟，不读本机时区。
 */

/** 把北京时间的年月日时分秒换成 Unix 毫秒。月份为 1–12。 */
export function beijingWallToUnixMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, second, ms);
}

/**
 * 解析 "YYYY-MM-DD HH:MM:SS" 为北京时间。
 * 格式或范围非法时抛错，文案与 {@link parseIso} 的本地解析保持同一风格。
 */
export function parseBeijingDateTime(value: string): Date {
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(value);
  if (matched === null) {
    throw new Error(`time data '${value}' does not match format '%Y-%m-%d %H:%M:%S'`);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const hour = Number(matched[4]);
  const minute = Number(matched[5]);
  const second = Number(matched[6]);
  if (month < 1 || month > 12) {
    throw new Error("month must be in 1..12");
  }
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > dim) {
    throw new Error("day is out of range for month");
  }
  if (hour < 0 || hour > 23) {
    throw new Error("hour must be in 0..23");
  }
  if (minute < 0 || minute > 59) {
    throw new Error("minute must be in 0..59");
  }
  if (second < 0 || second > 59) {
    throw new Error("second must be in 0..59");
  }
  return new Date(beijingWallToUnixMs(year, month, day, hour, minute, second));
}
