# Linux.do AI Reply Userscript

一个用于 linux.do 帖子页面的油猴/Tampermonkey 脚本：读取当前帖子的主体内容，按你配置的 AI `Base URL`、`API Key`、模型和提示词生成一条回复，并尽量自动填入 Linux.do 的回复编辑器。

## 功能

- 在 linux.do 帖子页右下角显示 **AI 回帖** 浮动按钮。
- 首次使用会弹出配置面板，可配置：
  - OpenAI 兼容接口 Base URL，例如 `https://api.openai.com/v1` 或你的中转地址
  - API Key
  - Model，例如 `gpt-4o-mini`、`deepseek-chat` 等
  - 系统/写作提示词
  - 是否自动填入编辑器
- 自动提取当前帖子的：
  - 标题
  - 楼主/主帖正文
  - 前几条可见回复摘要
  - 当前 URL
- 调用 `/chat/completions` 兼容接口生成回复。
- 支持复制生成结果，也会尝试打开回复框并填入内容。

## 安装

1. 浏览器安装 Tampermonkey / Violentmonkey。
2. 打开仓库里的 [`linuxdo-ai-reply.user.js`](./linuxdo-ai-reply.user.js)。
3. 在油猴扩展里新建脚本，复制粘贴保存。
4. 打开任意 `https://linux.do/t/...` 帖子页面。
5. 点击右下角 **AI 回帖** → **配置**，填入 Base URL / Key / Model / 提示词。
6. 点击 **生成回复**。

## Base URL 要求

脚本默认按 OpenAI Chat Completions 兼容协议请求：

```text
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json
```

如果你的服务商 Base URL 已经包含 `/v1`，就填完整的 `/v1`，例如：

```text
https://api.openai.com/v1
https://api.deepseek.com/v1
https://your-proxy.example.com/v1
```

## 默认提示词

默认提示词会要求模型：

- 用中文回复；
- 简洁、自然、像真实论坛用户；
- 不编造事实；
- 不输出免责声明；
- 不要太营销化。

你可以在配置面板里改成自己的风格。

## 隐私与安全

- API Key 存在浏览器 userscript 存储里，不会提交到本仓库。
- 帖子标题、正文和部分回复会发送给你配置的 AI 服务商。
- 请确认你信任所配置的 Base URL。

## 文件

- `linuxdo-ai-reply.user.js`：油猴脚本本体。
- `scripts/validate.mjs`：本地静态校验脚本。

## 本地校验

```bash
node --check linuxdo-ai-reply.user.js
node scripts/validate.mjs
```
