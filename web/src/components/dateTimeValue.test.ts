import { describe, expect, it } from "vitest";

import { formatDateTimeValue, parseDateTimeValue } from "./dateTimeValue";

describe("dateTimeValue", () => {
  it("开票时间空串没有日期，往返保持 YYYY-MM-DD HH:MM:SS", () => {
    expect(parseDateTimeValue("", "open-time").date).toBeUndefined();
    const date = new Date(2026, 9, 4);
    expect(formatDateTimeValue(date, "12:00:00", "open-time")).toBe("2026-10-04 12:00:00");
    const parts = parseDateTimeValue("2026-10-04 12:00:00", "open-time");
    expect(parts.time).toBe("12:00:00");
    expect(parts.date && formatDateTimeValue(parts.date, parts.time, "open-time")).toBe(
      "2026-10-04 12:00:00",
    );
  });

  it("监控时间写成 datetime-local，不带秒", () => {
    const date = new Date(2026, 9, 3);
    expect(formatDateTimeValue(date, "19:00", "datetime-local")).toBe("2026-10-03T19:00");
    const parts = parseDateTimeValue("2026-10-03T19:00:30", "datetime-local");
    expect(parts.time).toBe("19:00");
    expect(parts.date && formatDateTimeValue(parts.date, parts.time, "datetime-local")).toBe(
      "2026-10-03T19:00",
    );
  });

  it("非法日期不当作有效值", () => {
    expect(parseDateTimeValue("2026-13-40 25:61:00", "open-time").date).toBeUndefined();
    expect(parseDateTimeValue("2026-02-31T12:00", "datetime-local").date).toBeUndefined();
  });
});
