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
  'function requestChatCompletion(config, topic)',
  '/chat/completions',
  'Authorization: `Bearer ${config.apiKey}`',
  'function fillComposer(reply)',
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
