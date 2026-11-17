# Design System: Cohub

产品、用户与品牌语气见 [PRODUCT.md](PRODUCT.md)。

## Overview

- **风格**：技术硬核 + 简约高级。参考 Linear、Vercel Dashboard、Raycast 的克制感和精度感，但要有 Cohub 自己的识别度。
- **界面气质**：冷静、准确、专业。复杂信息要稳定呈现，不制造额外噪音。
- **视觉节奏**：高密度但不拥挤；用字号、字重、间距、对齐和少量色彩建立层级，少用边框和装饰性容器，避免把界面切成过多“框”。

1. **Precision over decoration** — 每个像素都有意义，不用装饰性元素填充空间。
2. **Information density with clarity** — 开发者工具需要高密度信息，但必须层次分明、易扫描。
3. **Brand cohesion** — 品牌色应作为交互状态、active 指示和重点元素的统一语言。
4. **Typographic hierarchy** — 用字重、字号、行高和密度建立层次，减少对边框和背景块的依赖。

## Colors

- **主题**：Dark mode 优先，同时支持 light / solarized 等多主题。主题必须通过 semantic theme tokens 表达，不能在组件里绕过用户选择。
- **品牌色**：`#FF3E00` 是品牌基准色，但实现里应使用 `brand` / `brand-*` 语义 token，不直接硬编码 hex。

Cohub Web 使用 semantic theme tokens 管理颜色与主题。文档只约束语义，不绑定具体文件结构；新增主题时应保持 token 语义完整一致。相关样式通常位于 `apps/web/src/styles/`。

- 组件应优先使用 `bg-bg-*`、`text-text-*`、`border-border-*`、`bg-brand`、`text-brand-contrast-fg`、`bg-overlay-*`、`text-error-*` 等语义 class。
- 不要在组件中硬编码 `#FF3E00`、`text-white`、`bg-black`、`bg-white`、`amber-*`、`cyan-*`、`indigo-*`、`purple-*` 等原始颜色。
- Overlay、modal、drawer、lightbox 使用 overlay token。
- Provider 品牌色使用 provider token。
- Focus ring、active indicator、selected background 优先使用品牌或边框语义 token，保持精确但不过度发光。
- 重复出现的控件用共享原语（`styles/components.css`），主题只改这些原语和 token，组件里不要写主题名：
  - 按键：主操作 `.primary-key`，旁边的次要操作 `.secondary-key`，已确认过的不可撤销操作 `.danger-key`；纯文字操作不用按键原语。
  - 选择：2–4 个等宽互斥选项用 `Segmented`；无轨道的标签 / 筛选用 `.tab-key`；开关用 `ToggleSwitch` / `.toggle-track`。
  - 标识：状态 / 元信息用 `.tag`（`data-tone` 着色），促销 / 当前标记用 `.badge`。
  - 浮层：菜单 / 下拉 `.menu-surface`，弹窗 `.dialog-backdrop` + `.dialog-surface`，提示 `.toast-surface`，加载 `Spinner`。
  - 「东西 / 去哪里」的入口图标用 `EntityIcon`（像素主题会换成彩色像素图），动作图标直接用 lucide。
- 「正在发生」（流式、运行中、唤醒、未读）用 `--activity`，不要直接用 `brand`；原生 checkbox / radio / range 自动跟随 `--control-accent`。

## Typography

- **字体**：使用 Geist / Geist Mono，保持工程工具的清晰、现代和克制。

## Layout

所有客户端（iOS、Android、macOS / Windows / Linux 桌面）都是薄原生壳，产品 UI 只有一份 Web 实现，跑在系统 WebView 里，通过 `cohub.host.v1` bridge 与壳通信（见 `docs/native-host-bridge.md`）。设计按 Web 做，不引入 Material、HIG 控件或平台专属视觉；但要守住 WebView 里的系统约定：

- **Edge to edge**：页面画在透明系统栏下，用 `safe-area-top` utility / `--safe-area-*` 避让刘海和手势条，固定浮层直接读 `env(safe-area-inset-*)`；外观变化时发 `appearance.set`。
- **返回**：可关闭的浮层（弹窗、抽屉、sheet）用 `dismissOnBack` 注册，Android 返回手势先关最上层；iOS 左缘滑动留给页面自身。
- **首屏**：首屏从本地数据渲染后调用 `app.ready`，原生启动屏才会撤下，不要等网络。
- **触控**：主要触控目标尽量做到 44px，最低不小于 24px；不依赖 hover，用 `touch:` 变体让操作常显；粗指针下输入框保持 16px 字号，避免聚焦时自动缩放；考虑软键盘遮挡。
- **文件**：下载走 `<a download>`，由壳转交 `files.save`，不要自造下载逻辑。

## Components

- Buttons 要有明确层级：primary 用品牌色，secondary / ghost / text action 保持低干扰。
- 表单、输入框、选择器应紧凑、清晰、可键盘操作，focus 状态要可见。
- 空状态要帮助用户理解下一步，而不是只说“暂无数据”。
- 错误信息要直接说明发生了什么，以及用户能做什么。
- 流式内容、工具调用和后台任务要优先保证可读性和稳定性，动画只用于表达状态，不制造噪音。
- 移动端要优先保证核心路径顺畅：布局可读、触控目标足够、输入稳定，不依赖 hover 或过密信息。
- 列表和侧栏应保持扫描效率：对齐、截断、状态点、时间和标题层级要一致。

### Motion

动效短促、克制，只表达状态变化。Token 与 overlay 过渡在 `#lib/motion.ts`，CSS 侧为 `--ease-out` / `--ease-drawer`（Tailwind `ease-out` / `ease-drawer`）与 `--motion-panel-*`，两边数值保持一致。以下规则适用于应用界面本身；Board 内容动画和营销页不受限。

- **先问该不该动**：键盘触发、每天上百次的操作（命令面板、`/` `@` 菜单、列表切换）不做动画；常用 hover 只变颜色；弹窗、抽屉、toast 用标准动画；首次 / 少见时刻才放 delight。
- **只用 ease-out**：进入、退出、按压、回弹都用 `--ease-out`，抽屉和 sheet 用 `--ease-drawer`；UI 不用 ease-in（开头慢，正是用户盯着看的时刻）。不手写 `cubic-bezier`。
- **时长**：按压 100–160ms；弹窗 / 浮层进 200ms、出 100ms；抽屉 / sheet 进 240ms、出 180ms；UI 动画不超过 300ms。
- **属性**：只动 `transform` / `opacity`（含 `scale` / `translate`）；不写 `transition-all` / `transition: all`；不从 `scale(0)` 出现，浮层从 0.96 放大，并以触发点为 `transform-origin`（居中弹窗除外）。
- **按压反馈**：按键原语按下 `scale: 0.97`；列表行、菜单项、工具键只变底色。
- **Hover 只给鼠标**：手写 `:hover` 放进 `@media (hover: hover)`（Tailwind `hover:` 已自带）；只靠 hover 显示的操作在触屏上用 `touch:` 变体常显。
- **Overlay**：弹窗、sheet、浮层及其遮罩用 `transition:overlay={{ kind }}`，可中途反向；元素要直接位于 `{#if open}` 分支内，否则 Svelte 的局部过渡不会播放。
- **减弱动效**：保留颜色和透明度，去掉位移与缩放；加载指示放慢而不是停止。
- 不使用 bounce / elastic 缓动；逐项延迟入场总时长不超过 300ms，数据列表直接出现。

## Do's and Don'ts

- **明确不要**：gradient text、glassmorphism、glowing neon accents、generic cyan / purple AI palette、Inter 字体、圆角卡片网格模板。
- **参考反例**：不要像 generic AI dashboard template。
