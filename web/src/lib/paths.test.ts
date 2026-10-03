import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveShotsDir, shotsDirCandidates } from "./paths";

/** 本用例创建的 tmp 根目录，afterEach 统一清理。 */
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 建 tmp 目录树并按需创建三层候选：
 * - env-shots/（env 候选指向它）
 * - damai_shots/（repoRoot 候选 = resolve(webCwd, "..") 之下）
 * - web/damai_shots/（webCwd 候选）
 */
function makeTree(opts: { envShots?: boolean; repoShots?: boolean; webShots?: boolean }): {
  root: string;
  webCwd: string;
  envDir: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "damai-shots-"));
  createdRoots.push(root);
  const webCwd = path.join(root, "web");
  mkdirSync(webCwd, { recursive: true });
  const envDir = path.join(root, "env-shots");
  if (opts.envShots) {
    mkdirSync(envDir);
  }
  if (opts.repoShots) {
    mkdirSync(path.join(root, "damai_shots"));
  }
  if (opts.webShots) {
    mkdirSync(path.join(webCwd, "damai_shots"));
  }
  return { root, webCwd, envDir };
}

describe("resolveShotsDir（三级候选解析）", () => {
  it("① env 命中优先——三层候选都存在时选 env", () => {
    const { webCwd, envDir } = makeTree({ envShots: true, repoShots: true, webShots: true });
    expect(resolveShotsDir({ cwd: webCwd, env: { DAMAI_WEB_SHOTS_DIR: envDir } })).toEqual({
      dir: envDir,
      source: "env",
    });
  });

  it("② env 未命中回落 repoRoot（仓库根/damai_shots）", () => {
    const { root, webCwd } = makeTree({ repoShots: true });
    expect(
      resolveShotsDir({ cwd: webCwd, env: { DAMAI_WEB_SHOTS_DIR: undefined } }),
    ).toEqual({ dir: path.join(root, "damai_shots"), source: "repoRoot" });
  });

  it("③ 仅 webCwd 候选存在时选 webCwd（web/damai_shots 历史兼容落点）", () => {
    const { webCwd } = makeTree({ webShots: true });
    expect(resolveShotsDir({ cwd: webCwd, env: {} })).toEqual({
      dir: path.join(webCwd, "damai_shots"),
      source: "webCwd",
    });
  });

  it("④ 三者均不存在 → null（页面据此渲染空态）", () => {
    const { webCwd } = makeTree({});
    expect(resolveShotsDir({ cwd: webCwd, env: {} })).toBeNull();
  });

  it("env 为空串视为未设置，照常回落", () => {
    const { root, webCwd } = makeTree({ repoShots: true });
    expect(
      resolveShotsDir({ cwd: webCwd, env: { DAMAI_WEB_SHOTS_DIR: "" } }),
    ).toEqual({ dir: path.join(root, "damai_shots"), source: "repoRoot" });
  });

  it("env 相对路径按 cwd（web/）解析", () => {
    const { webCwd } = makeTree({ webShots: true });
    expect(
      resolveShotsDir({ cwd: webCwd, env: { DAMAI_WEB_SHOTS_DIR: "damai_shots" } }),
    ).toEqual({ dir: path.join(webCwd, "damai_shots"), source: "env" });
  });
});

describe("shotsDirCandidates（候选清单存在性标注）", () => {
  it("env 已设置时列出三个候选并标注存在性（优先级有序）", () => {
    const { root, webCwd, envDir } = makeTree({ envShots: true, repoShots: true });
    const candidates = shotsDirCandidates({
      cwd: webCwd,
      env: { DAMAI_WEB_SHOTS_DIR: envDir },
    });
    expect(candidates).toEqual([
      { dir: envDir, source: "env", exists: true },
      { dir: path.join(root, "damai_shots"), source: "repoRoot", exists: true },
      { dir: path.join(webCwd, "damai_shots"), source: "webCwd", exists: false },
    ]);
  });

  it("env 未设置时跳过 env 候选（没有可检查的路径）", () => {
    const { root, webCwd } = makeTree({});
    const candidates = shotsDirCandidates({ cwd: webCwd, env: {} });
    expect(candidates).toEqual([
      { dir: path.join(root, "damai_shots"), source: "repoRoot", exists: false },
      { dir: path.join(webCwd, "damai_shots"), source: "webCwd", exists: false },
    ]);
  });
});
