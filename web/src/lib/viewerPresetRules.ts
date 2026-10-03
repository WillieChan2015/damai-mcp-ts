/** 单个快捷姓名的最大字数（按 UTF-16 码元，与输入框 maxLength 一致）。 */
export const VIEWER_PRESET_NAME_MAX = 32;

/** 快捷姓名条数上限。 */
export const VIEWER_PRESET_LIST_MAX = 30;

export type ViewerPresetResult =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

/**
 * 整理快捷姓名：去首尾空格、丢掉空串、按出现顺序去重。
 * 含逗号、超长或超过条数上限时整表拒绝，不返回半截结果。
 */
export function prepareViewerPresets(raw: readonly string[]): ViewerPresetResult {
  const names: string[] = [];
  for (const item of raw) {
    const name = item.trim();
    if (name === "") {
      continue;
    }
    if (name.includes(",") || name.includes("，")) {
      return { ok: false, error: "姓名不能包含逗号" };
    }
    if (name.length > VIEWER_PRESET_NAME_MAX) {
      return { ok: false, error: `姓名不能超过 ${VIEWER_PRESET_NAME_MAX} 个字` };
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  if (names.length > VIEWER_PRESET_LIST_MAX) {
    return { ok: false, error: `快捷姓名最多 ${VIEWER_PRESET_LIST_MAX} 个` };
  }
  return { ok: true, names };
}
