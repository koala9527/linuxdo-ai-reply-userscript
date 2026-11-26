# Linux.do 有一说一 · 回帖与浏览辅助

Linux.do 油猴脚本，提供本地回帖候选文案、浏览辅助和页面信号观察。

> 请遵守社区规则。脚本不会自动填写或发送回复，也不保证账号安全或网站阅读计数增长。

## 功能

- **回帖助手**：读取当前话题及已加载的回复，通过本地「有一说一」服务生成可复制的候选文案；默认地址为 `http://127.0.0.1:8011`。
- **浏览辅助**：从首页最新话题列表选择未访问的话题，按设置滚动和停留；每个话题结束后先返回首页，再选择下一个。
- **本地去重**：点击话题前保存话题 ID，后续跳过已记录的话题。历史保存在本地，可在浏览面板手动清空；列表没有可选话题时等待 5 分钟再检查；此间后台暂停、限流和验证规则仍然生效。
- **页面信号观察**：显示页面可见性、可见验证元素和可观察到的 `/topics/timings` 请求状态；这些信息不能评估账号安全。

## 安装和使用

1. 在 Chrome 中安装 Tampermonkey 或 Violentmonkey，安装[用户脚本](https://raw.githubusercontent.com/koala9527/linuxdo-ai-reply-userscript/main/linuxdo-ai-reply.user.js)。
2. 登录 Linux.do，打开右下角面板，在“浏览辅助”中设置速度与上限并手动开始。
3. 使用回帖助手时，需单独启动提供 `POST /api/v1/say-one` 的本地服务。

速度为 0% 时暂停，默认 10% 为基础速度，100% 为基础速度的 10 倍。默认上限为 12 个话题、45 个帖子、每话题 6 楼；数值输入支持到 99999，长期任务需同时调整话题和帖子目标，达到任一目标即结束。这些只是本地操作统计。

页面进入后台、出现可见验证，或观察到 HTTP 403/429 时，任务暂停并需要手动恢复；前台正常返回首页不会因页面卸载而暂停。脚本不处理验证、不伪造已读计时请求，也不模拟鼠标活动。

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
