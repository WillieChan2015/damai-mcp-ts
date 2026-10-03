"use server";

import { dumpUi } from "@core/inspector/dump";
import { findByText } from "@core/inspector/find";
import type { UIElement } from "@core/inspector/models";
import { UIElementNotFoundError } from "@core/utils/errors";

import { actionClient } from "@/lib/safe-action";

import {
  PROBE_META,
  capProbeElements,
  type ProbeDumpResult,
  type ProbeElement,
  type ProbeFindResult,
} from "./tree";
import { dumpUiSchema, findTextSchema } from "./schemas";

/**
 * 把 core UIElement 转成 probe 页载荷：`toDict()` + dump 序号；
 * attrs 仅在 core 侧非 null 时附带（`models.ts:51`）。
 */
function toProbeElement(el: UIElement, index: number | null): ProbeElement {
  const dict = el.toDict();
  return el.attrs !== null ? { ...dict, index, attrs: { ...el.attrs } } : { ...dict, index };
}

/**
 * Dump 当前 UI 层级（真机上单次可达 15s——`dump.ts:112` receiptTimeoutMs，UI 需 loading 态）。
 *
 * 返回 toDict() 数组 + index（扁平 DFS 列表、父索引未暴露，`dump.ts:85-89`），
 * 元素数截断到 3000 并置 truncated（防 Server Action 默认 1MB body 限制）；
 * 树结构由客户端按 bounds 重建（`./tree.ts` buildUiTree）。
 */
export const dumpDeviceUi = actionClient
  .schema(dumpUiSchema)
  .action(async ({ parsedInput }): Promise<ProbeDumpResult> => {
    const elements = await dumpUi(parsedInput.deviceId, {
      compressed: parsedInput.compressed,
    });
    const probeElements = elements.map((el, index) => toProbeElement(el, index));
    const capped = capProbeElements(probeElements);
    return { truncated: capped.truncated, elements: capped.elements, meta: PROBE_META };
  });

/**
 * find_text 试查（`find.ts:23` findByText）。
 *
 * 超时（UIElementNotFoundError，`find.ts:317-321` 文案已含 dump 节点数）是**正常试查结果**，
 * 返回 `{ found: false, error }` 而非抛给 serverError，避免丢失结构化语义；
 * 其他异常（设备离线等）仍走 serverError 通道。
 */
export const findTextProbe = actionClient
  .schema(findTextSchema)
  .action(async ({ parsedInput }): Promise<ProbeFindResult> => {
    try {
      const el = await findByText(parsedInput.deviceId, parsedInput.text, {
        exact: parsedInput.exact,
        clickableOnly: parsedInput.clickableOnly,
        timeout: parsedInput.timeoutSec,
      });
      // findByText 不暴露命中元素在 dump 中的位置，index 恒为 null（如实标注）
      return { found: true, element: toProbeElement(el, null), meta: PROBE_META };
    } catch (exc) {
      if (exc instanceof UIElementNotFoundError) {
        return { found: false, error: exc.message, meta: PROBE_META };
      }
      throw exc;
    }
  });
