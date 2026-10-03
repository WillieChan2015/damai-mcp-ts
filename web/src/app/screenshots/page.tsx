import { Card } from "@/components/ui/card";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { DeviceManager } from "@core/device/manager";

import { resolveShotsDir, shotsDirCandidates } from "@/lib/paths";

import { ScreenshotPreview } from "./ScreenshotPreview";
import { PageHeader } from "@/components/console";

export const dynamic = "force-dynamic";

export const metadata = { title: "截图墙 · Damai Console" };

/** 最多展示的截图张数（按 mtime 倒序截断，设计 §5.3）。 */
const MAX_SHOTS = 200;

/** 墙内单个条目。尺寸（分辨率）按设计留空：不解析 PNG 头，仅展示文件名 + mtime。 */
interface ShotEntry {
  name: string;
  mtimeMs: number;
}

/**
 * 抢票失败截图墙（设计 §5.3）。
 *
 * 数据源为 damai_shots 目录（core 抢票流程的失败现场截图落点）：
 * - 目录未就绪 → 空态文案 + 已检查的候选目录（shotsDirCandidates），优雅降级；
 * - 目录存在 → readdir 过滤 *.png、按 mtime 倒序、cap 200 张渲染网格；
 * - 图片经 `/screenshots/file/[name]` 路由供给（含路径穿越防护）。
 *
 * 顶部附设备实时截图预览（2s 轮询 `/api/devices/[id]/screenshot`）。
 */
export default async function ScreenshotsPage() {
  const resolution = resolveShotsDir();

  let devices: Array<{ deviceId: string; model?: string }> = [];
  try {
    // adb 缺失/失败时 listDevices 内部已捕获并返回缓存（空列表），这里兜底防御
    devices = (await DeviceManager.shared().listDevices(true)).map((d) => ({
      deviceId: d.deviceId,
      model: d.model,
      marketName: d.marketName,
      deviceName: d.deviceName,
    }));
  } catch {
    devices = [];
  }

  let shots: ShotEntry[] = [];
  let readError: string | null = null;
  if (resolution !== null) {
    try {
      const names = (await readdir(resolution.dir)).filter((n) => /\.png$/i.test(n));
      const entries = await Promise.all(
        names.map(async (name): Promise<ShotEntry> => {
          try {
            const s = await stat(path.join(resolution.dir, name));
            return { name, mtimeMs: s.mtimeMs };
          } catch {
            // stat 失败（竞态删除）保留条目、mtime 置 0 排到末尾
            return { name, mtimeMs: 0 };
          }
        }),
      );
      shots = entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SHOTS);
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="截图墙" lede="上方为设备实时画面（2s 轮询）；下方为抢票流程自动保存的失败现场截图（最新在前，最多 200 张）。" />
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink">在线设备实时视窗 (2s 轮询)</h2>
          <span className="font-mono text-xs text-muted">/api/devices/[id]/screenshot</span>
        </div>
        <ScreenshotPreview devices={devices} />
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-ink">抢票事故现场证据库</h2>
          <span className="text-xs text-muted">失败现场快照自动归档（倒序排列）</span>
        </div>

        {resolution === null ? (
          <div className="space-y-3 rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
            <p>
              未找到 damai_shots 截图目录。抢票失败时的现场截图（
              <code>open_fail_*</code> / <code>no_buy_btn_*</code> /{" "}
              <code>ready_for_human_*</code> / <code>grab_fail_*</code> 等）出现后，此处会自动显示。
            </p>
            <p className="text-xs">
              也可用环境变量 <code>DAMAI_WEB_SHOTS_DIR</code> 显式指定目录。已检查的候选：
            </p>
            <ul className="space-y-1 text-xs">
              {shotsDirCandidates().map((c) => (
                <li key={c.source} className="font-mono">
                  {c.dir} — {c.exists ? "存在" : "不存在"}
                </li>
              ))}
            </ul>
          </div>
        ) : readError !== null ? (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-6 text-center text-xs text-danger">
            读取截图目录失败（{resolution.dir}）：{readError}
          </div>
        ) : shots.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
            截图目录（{resolution.dir}）暂无 PNG 截图。
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {shots.map((shot) => (
              <figure
                key={shot.name}
                className="overflow-hidden rounded-lg border border-line bg-surface transition-all hover:border-line-strong"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/screenshots/file/${encodeURIComponent(shot.name)}`}
                  alt={`失败截图 ${shot.name}`}
                  loading="lazy"
                  className="aspect-[9/16] w-full object-contain bg-paper"
                />
                <figcaption className="space-y-1 border-t border-line p-2.5">
                  <p className="break-all font-mono text-[11px] font-medium text-ink">
                    {shot.name}
                  </p>
                  <p className="font-mono text-[10px] text-muted">
                    {shot.mtimeMs > 0 ? new Date(shot.mtimeMs).toLocaleString("zh-CN") : "—"}
                  </p>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
