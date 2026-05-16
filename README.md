# 禅道文档截图

自动登录禅道系统，截取项目空间文档内容为 PNG 图片。

## 安装

```bash
npm install
npx playwright install chromium
```

## 配置

编辑 `config.json`：

```json
{
  "baseUrl": "http://192.168.10.227:90/zentao",
  "username": "你的账号",
  "password": "你的密码",
  "outputPath": "./",
  "viewport": { "width": 1920, "height": 3600 }
}
```

## 使用

```bash
# 交互模式：选择项目 → 选择文档
node zentao-shot.js

# 指定项目，交互选文档
node zentao-shot.js "项目名"

# 直接截图
node zentao-shot.js "项目名" "文档名"
```

## 输出

截图保存在 `outputPath/<项目名>/<文档名>.png`，自动裁剪底部空白区域。

## 特性

- 自动登录（首次需密码，后续复用会话）
- 仅截取项目空间文档
- 自动跳过仅附件的文档（无内联正文）
- 支持 Affine 编辑器懒加载内容
- 自动裁剪空白区域
