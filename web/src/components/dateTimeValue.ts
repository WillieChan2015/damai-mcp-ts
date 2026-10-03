/** 抢票开票时间：`YYYY-MM-DD HH:MM:SS`（北京时间，空串 = 立即抢）。 */
export type OpenTimeFormat = "open-time";
/** 监控起止：`YYYY-MM-DDTHH:mm`（datetime-local，北京时间）。 */
export type DateTimeLocalFormat = "datetime-local";
export type DateTimeValueFormat = OpenTimeFormat | DateTimeLocalFormat;

export interface DateTimeParts {
  date: Date | undefined;
  /** `HH:mm` 或 `HH:mm:ss`。 */
  time: string;
}

const OPEN_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function clamp(raw: string, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(n)));
}

function localDate(year: number, month: number, day: number): Date | undefined {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  return date;
}

/** 空串或非法格式 → 无日期。默认时刻 12:00，供日历点选后写入。 */
export function parseDateTimeValue(value: string, format: DateTimeValueFormat): DateTimeParts {
  const fallback = format === "open-time" ? "12:00:00" : "12:00";
  const match = format === "open-time" ? OPEN_TIME.exec(value) : DATETIME_LOCAL.exec(value);
  if (!match) return { date: undefined, time: fallback };
  const date = localDate(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!date) return { date: undefined, time: fallback };
  const hh = pad(clamp(match[4] ?? "0", 23));
  const mm = pad(clamp(match[5] ?? "0", 59));
  if (format === "open-time") {
    return { date, time: `${hh}:${mm}:${pad(clamp(match[6] ?? "0", 59))}` };
  }
  return { date, time: `${hh}:${mm}` };
}

/** 写成 schema 接受的字符串。日期按本地年月日，不走 UTC。 */
export function formatDateTimeValue(
  date: Date,
  time: string,
  format: DateTimeValueFormat,
): string {
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const [hhRaw = "0", mmRaw = "0", ssRaw = "0"] = time.split(":");
  const hh = pad(clamp(hhRaw, 23));
  const mm = pad(clamp(mmRaw, 59));
  if (format === "open-time") {
    return `${y}-${mo}-${d} ${hh}:${mm}:${pad(clamp(ssRaw, 59))}`;
  }
  return `${y}-${mo}-${d}T${hh}:${mm}`;
}
