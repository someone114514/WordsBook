# WordsBook: GitHub 部署与移动端应用化

## 1. 推荐发布形态

1. 主形态：`PWA`（iPhone/Android 都可“安装到主屏幕”）。
2. 扩展形态：Android 可额外封装 `APK`（TWA / PWABuilder）。
3. iOS 约束：没有 Mac 时，无法走 App Store 原生上架；最佳方案是 PWA 安装。

## 2. 挂到 GitHub（自动发布）

项目已内置：

1. CI：`.github/workflows/ci.yml`
2. Pages 发布：`.github/workflows/deploy-pages.yml`
3. Vite 已支持 GitHub Pages 的 `base` 路径自动处理（仓库名子路径）。

你需要做的：

1. 创建 GitHub 仓库（建议公开仓库，Pages 更直接）。
2. 推送 `main` 分支。
3. 仓库 `Settings -> Pages`：
   - `Build and deployment` 选择 `GitHub Actions`。
4. 等待 `Deploy Pages` 工作流成功。
5. 打开生成的 `https://<user>.github.io/<repo>/`。

## 3. iPhone 安装为“应用”

1. iPhone 用 Safari 打开 Pages 地址。
2. 点“分享” -> “添加到主屏幕”。
3. 首次进入后安装词典，之后可离线查词/背词。

## 4. Android 打包为 APK（免费可行路径）

### 方案 A：直接 PWA 安装（最快）

1. Chrome 打开 Pages 地址。
2. 点“添加到主屏幕/安装应用”。

### 方案 B：生成 APK（TWA / PWABuilder）

1. 访问 `https://www.pwabuilder.com/`。
2. 输入你的 GitHub Pages URL。
3. 选择 Android 包，下载生成结果。
4. 可直接侧载；如需上架再补签名与商店配置。

## 5. 发布前检查

1. 确保 `npm run build` 本地通过。
2. `manifest`、`service worker`、图标同源可访问。
3. 线上地址必须 `HTTPS`。
4. iPhone 真机验证一次：
   - 安装到主屏幕
   - 词典安装
   - 飞行模式下查词/背词可用

## 6. 常见问题

1. 页面资源 404：通常是 `base` 路径错误（本项目已自动处理 GitHub Pages）。
2. 更新后还显示旧页面：PWA 缓存导致，先强刷或删除主屏幕应用重装。
3. iOS 数据被系统清理：定期在设置页导出备份再导入恢复。
