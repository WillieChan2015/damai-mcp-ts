/**
 * 选择器调试器的表单 schema（`probe/actions.ts` 与 client 表单共用）。
 *
 * 独立成文件的原因："use server" 模块只允许导出 async 函数（Next 16 构建期强制），
 * 而 client 侧 zodResolver 与 actions 单测都需要直接导入 schema。
 */
import { z } from "zod";

/** dumpUi 表单 schema（对应 `src/inspector/dump.ts:102` 的参数面）。 */
export const dumpUiSchema = z.object({
  deviceId: z.string().min(1),
  /** compressed=false 时 dump 含不可见控件（uiautomator dump 原生开关）。 */
  compressed: z.boolean().default(true),
});

export type DumpUiInput = z.input<typeof dumpUiSchema>;

/** find_text 试查 schema（对应 `src/inspector/find.ts:23` 的参数面；timeout 边界 1-30 秒）。 */
export const findTextSchema = z.object({
  deviceId: z.string().min(1),
  text: z.string().min(1),
  /** true = 整串相等（findByText 默认，find.ts:26）；false = 子串匹配。 */
  exact: z.boolean().default(true),
  /** 仅在 clickable 元素中查找（find.ts:27）。 */
  clickableOnly: z.boolean().default(false),
  /** 轮询等待秒数；findByText 超时按「未命中」呈现而非报错。 */
  timeoutSec: z.number().min(1).max(30).default(5),
});

export type FindTextInput = z.input<typeof findTextSchema>;

/** client 表单用的子集：deviceId 由工作区共享下拉提供，不进表单状态。 */
export const findTextFormSchema = findTextSchema.omit({ deviceId: true });

export type FindTextFormInput = z.input<typeof findTextFormSchema>;
