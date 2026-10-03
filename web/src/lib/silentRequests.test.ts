import { describe, expect, it } from "vitest";

import { SILENT_INCOMING_REQUESTS } from "./silentRequests";

function isSilent(url: string): boolean {
  return SILENT_INCOMING_REQUESTS.some((pattern) => pattern.test(url));
}

describe("SILENT_INCOMING_REQUESTS", () => {
  it("丢掉 /api/health 及其 query", () => {
    expect(isSilent("/api/health")).toBe(true);
    expect(isSilent("/api/health?t=1")).toBe(true);
    expect(isSilent("http://127.0.0.1:6123/api/health")).toBe(true);
  });

  it("保留其它页面操作请求", () => {
    expect(isSilent("/probe")).toBe(false);
    expect(isSilent("/api/tasks")).toBe(false);
    expect(isSilent("/api/devices/beb5a721/screenshot")).toBe(false);
    expect(isSilent("/api/healthcare")).toBe(false);
  });
});
