# WordsBook Liquid Glass Web 实现依据

## 结论

Apple 没有发布 Liquid Glass 的 CSS 参数或 Web API。原生效果由 Apple 平台的系统合成器动态生成，Web 端只能复刻它的使用边界、层级与交互原则，再用浏览器材质能力做稳定近似。

WordsBook 因此不使用第三方“Liquid Glass”库、SVG displacement、WebGL 折射或持续色散动画。Safari 是第一验收目标，Chrome 与 Firefox 使用同一基础路径。

## 官方边界

- Glass 属于浮在内容之上的功能层，用于 Tab Bar、侧栏、工具栏、搜索栏、菜单和 Sheet；普通列表、释义、阅读正文和学习卡片保持实体表面。
- 项目只采用 `regular` 材质近似；不使用面向照片/视频背景的 `clear` 变体。
- 静止状态保持安静，动效只响应按压、进入与布局变化；不动画 blur 半径。
- Tint 只用于当前导航、主操作与焦点，不给每个玻璃组件染色。
- 同屏避免玻璃嵌套，最多保留全局导航、上下文工具栏和一个浮层。

官方资料：

- [Apple HIG — Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [WWDC25 — Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)
- [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views)
- [Apple HIG — Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Apple HIG — Searching](https://developer.apple.com/design/human-interface-guidelines/searching)

## 项目采用的 Web 材质

这些是跨浏览器近似参数，不是 Apple 官方公开参数：

```css
:root {
  --glass-fill: rgb(255 255 255 / 0.72);
  --glass-fill-thick: rgb(255 255 255 / 0.90);
  --glass-border: rgb(255 255 255 / 0.82);
  --glass-shadow:
    0 12px 36px rgb(15 23 42 / 0.12),
    0 2px 8px rgb(15 23 42 / 0.08),
    inset 0 1px 0 rgb(255 255 255 / 0.92),
    inset 0 -1px 0 rgb(15 23 42 / 0.05);
}

.glass-surface {
  border: 1px solid var(--glass-border);
  background:
    radial-gradient(120% 90% at 12% -18%, rgb(255 255 255 / 0.76), transparent 62%),
    var(--glass-fill);
  -webkit-backdrop-filter: saturate(180%) blur(22px);
  backdrop-filter: saturate(180%) blur(22px);
  box-shadow: var(--glass-shadow);
}
```

- 固定导航与搜索工具栏使用 `blur(22px)` 和 `0.72` 白色填充。
- 大型 Sheet 使用 `blur(24px)` 和 `0.90` 白色填充。
- 边缘高光来自径向渐变与 inset highlight；正文不使用 `filter`。
- 实心主按钮使用更深的 `#0068D8`，保证白色普通文本达到 WCAG AA；`#007AFF` 保留为系统强调色。

## 兼容与降级

- 同时声明标准与 `-webkit-backdrop-filter`；不支持时回退为高不透明白色表面。
- `prefers-reduced-transparency: reduce` 时移除模糊并改用实体表面。该媒体查询仍属渐进增强，不能作为唯一降级入口。
- `prefers-contrast: more` 时取消透明度和阴影，用实体背景与清晰边框表达边界。
- `forced-colors: active` 时交给系统颜色，并移除装饰渐变。
- `prefers-reduced-motion: reduce` 时取消弹性、位移和长过渡。

兼容资料：

- [WebKit — Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/)
- [Safari 18 WebKit features](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)
- [MDN — backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)
- [WebKit Bug 245510 — SVG backdrop filters](https://bugs.webkit.org/show_bug.cgi?id=245510)

SVG `feDisplacementMap` 折射目前不能作为 Safari PWA 的生产基础。相关物理实现只用于理解 lensing 原理：[Liquid Glass in the Browser](https://kube.io/blog/liquid-glass-css-svg/)。
