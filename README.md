# 禅道文档截图

自动登录禅道系统，截取项目空间文档内容为 PNG 图片。

## 安装

```bash
npm install
```

> **注意**：不要用 `npx playwright install chromium`，该命令还会下载 chromium-headless-shell（额外 112MB）。
> 请手动下载 [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) 并放到 `~/AppData/Local/ms-playwright/chromium-1223/chrome-win64/`，脚本会自动检测该路径。

## 配置

创建 `config.json`（已在 .gitignore 中，不会提交）：

```json
{
  "baseUrl": "http://your-zentao-host/zentao",
  "username": "your_username",
  "password": "your_password",
  "outputPath": "./",
  "viewport": { "width": 1920, "height": 3600 }
}
```

## 使用

### 交互模式（zentao-shot.js）

```bash
# 交互选项目 → 选文档
node zentao-shot.js

# 指定项目，交互选文档
node zentao-shot.js "项目名"

# 直接截图单个文档
node zentao-shot.js "项目名" "文档名"
```

### 批量模式（batch-shot.js）

```bash
# 一次截多个文档
node batch-shot.js "项目名" "文档1" "文档2" "文档3"
```

## 输出

截图保存在 `<outputPath>/<项目名>/<文档名>.png`，自动裁剪底部空白区域。

## 特性

- 自动登录（首次需密码，后续复用 session）
- 仅截取项目空间文档
- 支持 Affine 编辑器（新版禅道）和旧版编辑器
- 支持纯图片文档（内联图片，非附件）
- 自动跳过仅附件文档（无内联正文也无内联图片）
- 自动裁剪底部空白区域
- 遍历所有 frames 定位真实内容，兼容禅道 SPA 导航

## 已测试环境

- 禅道开源版 21.7.8
- Node.js v24
- Chrome for Testing 148.0.7778.96 (Playwright chromium v1223)
- Windows 11

