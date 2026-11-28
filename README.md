# Linux.do 有一说一 · 回帖与浏览辅助

Linux.do 油猴脚本，提供本地回帖候选文案、浏览辅助和页面信号观察。

> 请遵守社区规则。脚本不会自动填写或发送回复，也不保证账号安全或网站阅读计数增长。

## 功能

- **回帖助手**：读取当前话题及已加载的回复，通过本地「有一说一」服务生成可复制的候选文案；默认地址为 `http://127.0.0.1:8011`。
- **浏览辅助**：从首页最新话题列表选择未访问的话题，按设置滚动和停留；每个话题结束后先返回首页，再选择下一个。
- **本地去重**：点击前保存话题 ID，跳过已访问话题；当前列表浏览完会滚动加载更多。没有新话题时等待 5 分钟再刷新，期间有新话题加载则继续；历史可在面板清空。
- **页面信号观察**：显示页面可见性、可见验证元素和可观察到的 `/topics/timings` 请求状态；这些信息不能评估账号安全。

## 安装和使用

1. 在 Chrome 中安装 Tampermonkey 或 Violentmonkey，安装[用户脚本](https://raw.githubusercontent.com/koala9527/linuxdo-ai-reply-userscript/main/linuxdo-ai-reply.user.js)。
2. 登录 Linux.do，打开右下角面板，在“浏览辅助”中设置速度与上限并手动开始。
3. 使用回帖助手时，需单独启动提供 `POST /api/v1/say-one` 的本地服务。

速度为 0% 时暂停，默认 10% 为基础速度，100% 为基础速度的 10 倍。默认上限为 12 个话题、45 个帖子、每话题 6 楼；数值输入支持到 99999，长期任务需同时调整话题和帖子目标，达到任一目标即结束。这些只是本地操作统计。

页面进入后台、出现验证或 HTTP 401/429 时暂停，需手动恢复。浏览请求遇到无验证信号的 403、网络错误或部分服务端错误时，按 15 秒、45 秒等待后刷新，每个任务最多两次；次数和进度跨刷新保留，仍失败则手动处理。暂停、停止或速度设为 0 会取消待执行的刷新。

前台正常返回首页和重试刷新会保留任务进度。脚本不处理验证、不伪造已读计时请求，也不模拟鼠标活动。

## Chrome 调试与验证

调试控制器需要 Node.js 22+ 和已开启的本机 Chrome 9222 调试端口；普通登录窗口不一定开启该端口。控制器不会重启浏览器或复制个人配置。

```bash
node scripts/chrome-controller.mjs --status
node scripts/chrome-controller.mjs --browse --speed=10
node scripts/chrome-controller.mjs --pause
node scripts/chrome-controller.mjs --stop

node --check linuxdo-ai-reply.user.js
node scripts/validate.mjs
node --test scripts/*.test.mjs
```
