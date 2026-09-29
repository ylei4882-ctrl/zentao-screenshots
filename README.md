# 禅道文档截图

登录禅道系统（每人用自己的账号），截取项目空间文档内容为 PNG 图片。

## 安装

```bash
npm install
```

> **注意**：不要用 `npx playwright install chromium`，该命令还会下载 chromium-headless-shell（额外 112MB）。
> 请手动下载 [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) 并放到 `~/AppData/Local/ms-playwright/chromium-1223/chrome-win64/`，脚本会自动检测该路径。

## 登录（每人用自己的禅道账号）

两种方式任选一种：

1. **弹窗登录（不保存密码）**：直接运行，或先执行 `node zentao-shot.js --login`。脚本会弹出浏览器窗口，用自己的账号登录即可，登录成功后窗口自动关闭。之后会复用登录会话；会话过期时会再次弹窗。
2. **config.json 写自己的账号密码（自动登录）**：见下方「配置」。如果密码失效（比如改过密码），脚本会自动改用弹窗登录，弹窗里会预先填好用户名。

```bash
node zentao-shot.js --login    # 登录 / 切换账号（只登录，不截图）
node zentao-shot.js --logout   # 退出：删除本机保存的登录会话
```

登录会话保存在 `%USERPROFILE%\.zentao-screenshots\session.json`，每个 Windows 用户一份，只存在本机。**不要把它发给别人**，它等同于你的登录状态。

## 配置（可选）

不创建 config.json 也能用：地址用默认值，登录用弹窗。需要时创建 `config.json`，推荐放在
`%USERPROFILE%\.zentao-screenshots\config.json`，这样工具文件夹里不含任何个人信息，可以直接拷给别人。
放在工具目录下的旧位置也兼容（已在 .gitignore 中，不会提交）。两处都有时，以个人目录的为准。

```json
{
  "baseUrl": "http://your-zentao-host/zentao",
  "username": "自己的账号（可选）",
  "password": "自己的密码（可选；不填则弹窗登录）",
  "outputPath": "./",
  "viewport": { "width": 1920, "height": 3600 }
}
```

环境变量（可选）：`ZENTAO_HOME` 可以改个人目录的位置；`ZENTAO_LOGIN_TIMEOUT` 设置弹窗等待登录的秒数，默认 300。

## 使用

### 交互模式（zentao-shot.js）

```bash
# 交互选项目 → 选文档
node zentao-shot.js

# 指定项目，交互选文档
node zentao-shot.js "项目名"

# 直接截图指定文档，可一次写多个（有同名文档时，第二篇写 "文档名 (2)"，依此类推）
node zentao-shot.js "项目名" "文档1" "文档2"
```

### 批量模式（batch-shot.js）

与 `node zentao-shot.js "项目名" "文档1" "文档2" ...` 完全相同，保留此入口以兼容旧用法。

```bash
# 一次截多个文档
node batch-shot.js "项目名" "文档1" "文档2" "文档3"
```

## 输出

截图保存在 `<outputPath>/<项目名>/<文档名>.png`，自动裁剪底部空白区域。
同名文档按列表顺序保存为 `<文档名>.png`、`<文档名> (2).png`、`<文档名> (3).png`…

## 特性

- 每人用自己的账号：弹窗登录（不保存密码）或 config.json 自动登录；会话存放在个人目录，过期前一直复用
- 仅截取项目空间文档；文档列表取自项目的「全部文档」视图（已含各阶段库，不含附件库里的文件）
- 按文档 ID 打开文档，同名文档也能区分
- 多选截图时单篇失败不影响其余，结束后输出汇总
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

