# Linux.do AI 回帖助手

一个用于 linux.do 帖子页面的油猴/Tampermonkey 脚本：读取当前帖子的主体内容，按你配置的 AI `Base URL`、`API Key`、模型和提示词生成候选回复，并一键复制到剪贴板。

## 功能

- 在 linux.do 帖子页右下角显示 **AI 回帖** 浮动按钮。
- 首次使用会弹出配置面板，可配置：
  - OpenAI 兼容接口 Base URL，例如 `https://api.openai.com/v1` 或你的中转地址
  - API Key
  - Model，例如 `gpt-4o-mini`、`deepseek-chat` 等
  - 系统/写作提示词模板
  - 回复个数，支持 `1-10` 条
  - 是否进入帖子后自动生成候选回复
- 自动提取当前帖子的：
  - 标题
  - 楼主/主帖正文
  - 前几条可见回复摘要
  - 当前 URL
- 调用 `/chat/completions` 兼容接口生成回复。
- 要求模型按 `===AI_REPLY_序号===` 固定格式返回，并只提取这些块作为候选回复。
- 多条候选回复会分开展示，每条都可以单独复制，也可以一键复制全部。
- 支持复制生成结果，不会自动打开或填入 Linux.do 回复窗口。
- 可开启“进入帖子自动生成”，识别到新帖子后提前生成候选回复；自动生成不会改写剪贴板，需要时复制单条或复制全部。
- 切换提示词模板后会自动用新模板重新生成候选回复，方便快速比较不同风格；该自动生成同样不会改写剪贴板。
- 支持 5 组提示词模板：前 3 组为可修改、可重置、不可删除的预设；后 2 组为可新增、可修改、可删除的自定义模板。
- Base URL 和 API Key 默认隐藏，可手动显示/隐藏；状态日志会对中转站地址和 Key 做脱敏。
- 面板默认更高，并支持拖拽右下角手柄拉宽拉长，方便截图和查看长提示词。

## 安装

1. 浏览器安装 Tampermonkey / Violentmonkey。
2. 打开 GitHub Raw 安装地址：`https://raw.githubusercontent.com/koala9527/linuxdo-ai-reply-userscript/main/linuxdo-ai-reply.user.js`。
3. 在油猴扩展里新建脚本，复制粘贴保存。
4. 打开任意 `https://linux.do/t/...` 帖子页面。
5. 点击右下角 **AI 回帖** → **配置**，填入 Base URL / Key / Model / 提示词。
6. 选择回复个数，点击 **生成回复**；也可以打开 **进入帖子自动生成**。
7. 生成后会按条展示候选回复，可以复制单条，也可以点击 **复制全部**。

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

也可以直接填完整接口地址，例如 `https://your-proxy.example.com/v1/chat/completions`。不要填写中转站控制台、官网首页或只有登录页面的地址；如果脚本提示“接口返回了网页 HTML”，通常就是 Base URL 没有指向 API 入口。

## 提示词模板

默认内置 3 组风格模板，都会先理解 linux.do 的社区文化：技术交流、经验分享、和谐友善、适度玩梗；对认真内容可以鼓励，对明显水贴、破事、伸手党内容可以温和质疑、轻轻点醒。

- **贴吧老哥**：神回复方向，短、歪、准；对好内容能抬一手，对水贴能犀利吐槽但不攻击。
- **B站峰哥**：偏“这是好事”式反向解构，把认真内容解释成良性循环，把破事水贴解释成筛选、祛魅、认清现实。
- **Neo 始皇**：更有威仪和判断力，先定调再补方向；该赏则赏，该轻压则轻压。

前 3 组预设都可以修改，也可以一键重置为默认；自定义模板保存时标题和提示词都必须是非空字符串。

## 输出格式

脚本会把回复个数和固定格式要求一起发送给模型。模型应返回类似：

```text
===AI_REPLY_1===
第一条回复正文

===AI_REPLY_2===
第二条回复正文
```

脚本只会提取这些 `===AI_REPLY_n===` 块，按条展示；如果模型没按格式返回，会提示重新生成或调整提示词。

## 隐私与安全

- API Key 存在浏览器 userscript 存储里，不会提交到本仓库。
- 帖子标题、正文和部分回复会发送给你配置的 AI 服务商。
- Base URL、API Key 输入框默认以密码框形式隐藏，日志中的中转站地址和 Key 会打码。
- 请确认你信任所配置的 Base URL。

## 文件

- `linuxdo-ai-reply.user.js`：油猴脚本本体。
- `scripts/validate.mjs`：本地静态校验脚本。

## 本地校验

```bash
node --check linuxdo-ai-reply.user.js
node scripts/validate.mjs
```

## 自动更新

脚本头部已配置 GitHub Raw 的 `@updateURL` 和 `@downloadURL`。后续只要递增 `@version` 并推送到 GitHub，Tampermonkey / Violentmonkey 就能按版本检查更新。
