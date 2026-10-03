/**
 * 观演人快捷姓名（任务页「快捷添加」）。
 *
 * 存在与任务相同的 SQLite 库（{@link resolveTaskDbPath}，默认 `web/data/tasks.db`）
 * 的 `viewer_presets` 表里，一行一个姓名，`position` 为显示顺序。
 * 库文件不存在时读路径不建库，返回空数组。名单非法按空数组处理。
 * 写入失败抛中文错误，让页面保留原名单。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { logger } from "@core/utils/logging";

import { resolveTaskDbPath } from "@/task/persistence";

import { prepareViewerPresets } from "./viewerPresetRules";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS viewer_presets (
  position INTEGER PRIMARY KEY,
  name TEXT NOT NULL
)`.trim();

function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 打开任务库并确保快捷姓名表存在。调用方负责 close。 */
function openDb(): Database.Database {
  const dbPath = resolveTaskDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE_SQL);
  return db;
}

/**
 * 读取已保存的快捷姓名。库不存在、读失败或内容不合法都返回空数组，不抛。
 */
export function loadViewerPresets(): string[] {
  const dbPath = resolveTaskDbPath();
  if (!existsSync(dbPath)) {
    return [];
  }
  let db: Database.Database | null = null;
  try {
    db = openDb();
    const rows = db.prepare("SELECT name FROM viewer_presets ORDER BY position ASC").all() as Array<{
      name: unknown;
    }>;
    const raw = rows.map((row) => (typeof row.name === "string" ? row.name : ""));
    const prepared = prepareViewerPresets(raw);
    if (!prepared.ok) {
      logger.debug(`观演人快捷项无效，按空名单处理：${prepared.error}`);
      return [];
    }
    return prepared.names;
  } catch (exc) {
    logger.debug(`读取观演人快捷项失败，按空名单处理：${excToStr(exc)}`);
    return [];
  } finally {
    db?.close();
  }
}

/**
 * 用这份名单覆盖快捷姓名表。
 *
 * @param names 调用方传入的名单；此处再经 {@link prepareViewerPresets} 整理。
 * @throws 中文 Error：名单非法，或写库失败。
 */
export function saveViewerPresetsStore(names: readonly string[]): string[] {
  const prepared = prepareViewerPresets(names);
  if (!prepared.ok) {
    throw new Error(prepared.error);
  }
  let db: Database.Database | null = null;
  try {
    db = openDb();
    const replace = db.transaction((next: readonly string[]) => {
      db!.exec("DELETE FROM viewer_presets");
      const insert = db!.prepare("INSERT INTO viewer_presets (position, name) VALUES (?, ?)");
      next.forEach((name, position) => {
        insert.run(position, name);
      });
    });
    replace(prepared.names);
    return prepared.names;
  } catch (exc) {
    throw new Error(`保存观演人快捷项失败: ${excToStr(exc)}`);
  } finally {
    db?.close();
  }
}
