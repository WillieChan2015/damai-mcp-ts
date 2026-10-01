/**
 * 大麦 (cn.damai) profile（Python `app/profiles/damai.py` 的 TS 对应物）。
 *
 * 经由既有的 `damai_grab`（damai 模块）触发，而不是走通用的 step runner ——
 * 大麦的 UI 最复杂（实名制、J2C 壳、APM），包装成 profile 会丢失保真度。
 *
 * 因此本 profile 基本是声明式的：runner 查到此 profile，并在
 * `kind=='damai_special'` 时分发给 `damai_grab`。
 */
import { AppProfile, Step } from "../profile";

/** 大麦内置 profile（对应 Python 的 `DAMAI_PROFILE` 常量）。 */
export const DAMAI_PROFILE = new AppProfile({
  name: "damai",
  packageName: "cn.damai",
  deepLinkTemplate: "damai://item/{item_id}",
  hints: [
    "Uses J2C (Aliyun obfuscation) shell, native APM protection",
    "Requires login (saved by damai_login_check)",
    "Picker requires real-name viewer name",
  ],
  viewerPicker: "观演人",
  steps: [
    // Step 列表是声明式的；当 profile name == 'damai' 时，runner 经
    // runProfile 的特殊分支进行分发。
    new Step({
      name: "delegate_to_damai_grab",
      action: "sleep", // 占位，永不执行
      args: { seconds: 0.0 },
    }),
  ],
});
