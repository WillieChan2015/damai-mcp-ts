/**
 * 内置 app profiles（Python `app/profiles/__init__.py` 的 TS 对应物）。
 *
 * 由 `app/profile.ts` 的 {@link loadProfile} 按需载入注册表，注册表初始为空。
 *
 * 导入说明：本模块被 `profile.ts` 经动态 `import()` 惰性加载，因此这里的
 * 静态导入（damai/maoyan/fliggy → profile.ts）不构成会触发 TDZ 的循环求值
 * ——`profiles/*` 对 `profile.ts` 是单向依赖，`profile.ts` 对本模块只有
 * 异步的动态导入。
 */
import type { AppProfile } from "../profile";

import { DAMAI_PROFILE } from "./damai";
import { FLIGGY_PROFILE } from "./fliggy";
import { MAOYAN_PROFILE } from "./maoyan";

export { DAMAI_PROFILE, MAOYAN_PROFILE, FLIGGY_PROFILE };

/**
 * 把所有内置 profile 注册进 `registry`（对应 Python 的 `_register_builtins`）。
 *
 * 已存在于 registry 中的名字跳过（幂等——重复调用不会覆盖同名 profile）。
 */
export function registerBuiltins(registry: Map<string, AppProfile>): void {
  for (const profile of [DAMAI_PROFILE, MAOYAN_PROFILE, FLIGGY_PROFILE]) {
    if (registry.has(profile.name)) {
      continue;
    }
    registry.set(profile.name, profile);
  }
}
