# Web 控制台视觉规范（frontend-design skill 落地备忘）

依据 anthropics/skills 的 frontend-design SKILL 于 2026-10-03 重设计。后续迭代改 UI 前先读这份。

## 主题：「开演前的指挥台」

视觉母题全部来自抢票场景本身：**票根打孔线**（唯一装饰母题，只用于纸面底色区域）、
**戏剧海报衬线标题**、**信号灯式任务状态**。时间是唯一主角——首页实时时钟是 hero，
它是真数据而非装饰。

## 令牌（web/src/app/globals.css）

- 色板：`--paper #f4f5f7`（冷灰纸面）/ `--surface #fff` / `--ink #16181d` /
  `--muted` / `--line` / `--accent #c22f63`（胭脂，唯一品牌强调色）/
  功能信号 `--ok --warn --danger --info`（只表达任务状态）。暗色经
  `prefers-color-scheme` 整组翻转；改动色板只动 :root，别在组件里写死 zinc。
- 字体三角色：`font-display`（Noto_Serif_SC 600/900，品牌与页题）、
  Geist Sans（正文，中文回落 PingFang SC）、Geist Mono（**仅真数据**：
  id/token/时间/日志行——不给小标签用，这是 skill 点名的 tell）。
- 结构件：`.panel`（线框、无阴影、10px）、`.field`（全局 input/select/textarea
  已在 base 层统一，页面里不要再写边框串）、`.btn / .btn-primary / .btn-danger`、
  `.perforation`、`.live-dot`（呼吸动画，只表达运行态）。

## 从 skill 提炼并已执行的自我审查

规避的默认 tell：SaaS 同质卡片组（等宽圆角卡 + 同款阴影）→ 首页改索引行列表；
奶油底 + 赤陶强调；全大写眉标；单字变色标题；按钮/链接尾缀箭头；无序列的编号标记。
文案规则：按钮说结果（"启动抢票任务"），空态给行动指引，错误不道歉、说清楚怎么办。

## 已知边界

- 深浅色都支持（系统偏好切换）；改动组件时成对的 `text-zinc-900 dark:text-zinc-50`
  这类旧写法应替换为 `text-ink` 等令牌类。
- 全页截图在 IAB 下会因 sticky header + backdrop-blur 出现拼接伪影——视觉自检用
  视口截图分屏段看，或以 evaluate 读 DOM 数量为准。
