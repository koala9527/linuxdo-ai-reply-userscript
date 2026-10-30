import fs from 'node:fs';

const scriptPath = new URL('../linuxdo-ai-reply.user.js', import.meta.url);
const source = fs.readFileSync(scriptPath, 'utf8');

const requiredHeaders = [
  '// ==UserScript==',
  '// @name         Linux.do 有一说一 · 回帖助手',
  '// @match        https://linux.do/*',
  '// @grant        GM_xmlhttpRequest',
  '// @connect      127.0.0.1',
  '// ==/UserScript==',
];

const requiredSnippets = [
  // 页面解析
  'function parseTopicPath(pathname)',
  'function getTopicTitle()',
  'function extractPostText(article)',
  'function extractPostAuthor(article)',
  'function extractPostFloor(article)',
  'function collectTopic()',
  'article[data-post-id]',
  '.post__regular .cooked',
  'h1.header-title',
  // 输入构造
  'function buildInputText(topic)',
  '【楼主】',
  '【本页回复】',
  'MAX_INPUT_LEN = 2000',
  // 接口
  'function requestSayOne(text, tone)',
  '/api/v1/say-one',
  '/api/health',
  // 状态与 UI
  'function setStatus(status, patch)',
  'function renderFab()',
  'function renderPanel()',
  'ldya-fab',
  'ldya-panel',
  '复制回复',
  '重新生成',
  // 路由
  'function installRouter()',
  'history[name] = function patched()',
  "window.addEventListener('popstate'",
  'function handleRouteChange(source)',
  'function currentRouteId()',
  // 生成
  'function runGenerate(options)',
  'function maybeAutoGenerate(options)',
  'function waitForContent(timeout)',
];

const missing = [];
for (const item of [...requiredHeaders, ...requiredSnippets]) {
  if (!source.includes(item)) missing.push(item);
}

// 旧版本遗留的直接调用 OpenAI 兼容接口 / 提示词模板逻辑必须彻底移除
const forbidden = ['/chat/completions', '===AI_REPLY_', 'BUILTIN_PROMPT_TEMPLATES', 'Authorization: `Bearer'];
const leftovers = forbidden.filter((item) => source.includes(item));

if (missing.length || leftovers.length) {
  if (missing.length) {
    console.error('缺少必需片段：');
    for (const item of missing) console.error('  - ' + item);
  }
  if (leftovers.length) {
    console.error('仍残留旧实现片段：');
    for (const item of leftovers) console.error('  - ' + item);
  }
  process.exit(1);
}

console.log('校验通过：' + scriptPath.pathname);
console.log('文件大小：' + (source.length / 1024).toFixed(1) + ' KB');
