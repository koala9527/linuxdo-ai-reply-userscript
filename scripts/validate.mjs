import fs from 'node:fs';

const scriptPath = new URL('../linuxdo-ai-reply.user.js', import.meta.url);
const source = fs.readFileSync(scriptPath, 'utf8');

const requiredHeaders = [
  '// ==UserScript==',
  '// @name         Linux.do AI Reply Assistant',
  '// @match        https://linux.do/t/*',
  '// @grant        GM_xmlhttpRequest',
  '// @connect      *',
  '// ==/UserScript==',
];

const requiredSnippets = [
  'function collectTopicContent()',
  'function buildChatCompletionsUrl(baseUrl)',
  'function describeApiError(response, data, url)',
  'const BUILTIN_PROMPT_VERSION',
  'const BUILTIN_PROMPT_TEMPLATES',
  'const MAX_PROMPT_TEMPLATES = 5',
  'function validatePromptTemplates(templates)',
  'function renderPromptTabs()',
  'const REPLY_BLOCK_RE',
  'function clampReplyCount(value)',
  'function extractReplyBlocks(rawText, expectedCount)',
  'function formatRepliesForCopy(replies)',
  'function renderReplyCards(replies)',
  'function getReplyTextByIndex(index)',
  'function getCurrentReplyTexts()',
  'function sanitizeLogMessage(message)',
  'function toggleSecretInput(inputId, buttonId)',
  'function attachPanelResizeHandle(panel)',
  'function maybeAutoGenerate()',
  'function watchTopicNavigation(onChange)',
  'function getTopicIdFromPath(pathname)',
  'topic:${topicId}',
  'if (!topicKey) return;',
  'function requestChatCompletion(config, topic)',
  '/chat/completions',
  '===AI_REPLY_',
  `id="\${APP_ID}-reply-count"`,
  `id="\${APP_ID}-auto-generate"`,
  `id="\${APP_ID}-reply-list"`,
  'data-copy-reply-index',
  'GM_setValue(\'autoGenerate\'',
  'Accept: \'application/json\'',
  'Authorization: `Bearer ${config.apiKey}`',
  'AI 回帖',
];

const missing = [];
for (const item of [...requiredHeaders, ...requiredSnippets]) {
  if (!source.includes(item)) missing.push(item);
}

if (missing.length) {
  console.error('Validation failed. Missing:');
  for (const item of missing) console.error(`- ${item}`);
  process.exit(1);
}

console.log('Validation passed: userscript metadata and core functions are present.');
