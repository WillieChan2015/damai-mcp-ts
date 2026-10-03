import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

/**
 * 纯函数直测（不起服务）。通过 env `DAMAI_WEB_SHOTS_DIR` 把
 * resolveShotsDir() 指向 tmp 目录；测试进程 cwd=web/ 下两级回落候选
 * （仓库根/damai_shots、web/damai_shots）均不存在（实测），
 * 即便 stray 目录出现，name 不存在时同样落到 404 分支，用例仍稳定。
 */
describe("GET /screenshots/file/[name]", () => {
  let shotsDir: string;
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG 魔数

  beforeEach(() => {
    shotsDir = mkdtempSync(path.join(tmpdir(), "shots-file-"));
    vi.stubEnv("DAMAI_WEB_SHOTS_DIR", shotsDir);
    writeFileSync(path.join(shotsDir, "open_fail_20261003_120000.png"), pngBytes);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(shotsDir, { recursive: true, force: true });
  });

  it("合法文件名 → 200 + image/png + no-store + 原字节", async () => {
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ name: "open_fail_20261003_120000.png" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pngBytes);
  });

  it("路径穿越名（../、子目录、裸 ..）→ 400", async () => {
    for (const name of [
      "../open_fail_20261003_120000.png",
      "sub/secret.png",
      "..",
      "..\\open_fail_20261003_120000.png",
      "evil.txt",
      "",
    ]) {
      const res = await GET(new Request("http://localhost/x"), {
        params: Promise.resolve({ name }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("合法但不存在 → 404", async () => {
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ name: "missing_20261003.png" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("截图不存在");
  });

  it("目录未就绪（env 指向不存在的目录且无回落候选可用）→ 404", async () => {
    vi.stubEnv("DAMAI_WEB_SHOTS_DIR", path.join(shotsDir, "nope"));
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ name: "open_fail_20261003_120000.png" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("未找到 damai_shots");
  });
});
