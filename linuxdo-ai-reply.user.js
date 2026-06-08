// ==UserScript==
// @name         Linux.do AI Reply Assistant
// @namespace    https://git.tuwei.space/koala9527/linuxdo-ai-reply-userscript
// @version      0.1.0
// @description  Read linux.do topic content and generate a reply with an OpenAI-compatible API.
// @author       Hermes Agent
// @match        https://linux.do/t/*
// @match        https://www.linux.do/t/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'linuxdo-ai-reply-assistant';
  const DEFAULT_PROMPT = `你是 linux.do 论坛的真实用户。请根据帖子内容写一条自然、有帮助的中文回复。
要求：
1. 简洁，不要长篇大论，通常 80-220 字。
2. 语气友好、像真人论坛回复，不要像营销文案或 AI 公告。
3. 不要编造帖子里没有的信息。
4. 如果适合，可以给出具体建议、追问或补充观点。
5. 不要输出“作为 AI”“免责声明”等套话。`;

  const state = {
    busy: false,
    lastReply: '',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function getConfig() {
    return {
      baseUrl: (GM_getValue('baseUrl', '') || '').trim().replace(/\/+$/, ''),
      apiKey: GM_getValue('apiKey', '') || '',
      model: (GM_getValue('model', 'gpt-4o-mini') || 'gpt-4o-mini').trim(),
      prompt: GM_getValue('prompt', DEFAULT_PROMPT) || DEFAULT_PROMPT,
      autoFill: GM_getValue('autoFill', true),
    };
  }

  function saveConfig(config) {
    GM_setValue('baseUrl', (config.baseUrl || '').trim().replace(/\/+$/, ''));
    GM_setValue('apiKey', config.apiKey || '');
    GM_setValue('model', (config.model || '').trim() || 'gpt-4o-mini');
    GM_setValue('prompt', config.prompt || DEFAULT_PROMPT);
    GM_setValue('autoFill', Boolean(config.autoFill));
  }

  function textOf(node) {
    return (node?.innerText || node?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function clipText(text, maxLength) {
    if (!text || text.length <= maxLength) return text || '';
    return `${text.slice(0, maxLength)}\n……（已截断，原文约 ${text.length} 字）`;
  }

  function getTopicTitle() {
    return textOf($('h1 a.fancy-title, h1 .fancy-title, h1, title')) || document.title.replace(/ - Linux\.do.*$/i, '').trim();
  }

  function findPostCookedNodes() {
    const selectors = [
      'article[data-post-id] .cooked',
      '.topic-post .cooked',
      '#post_1 .cooked',
      '.regular.contents .cooked',
    ];
    for (const selector of selectors) {
      const nodes = $$(selector).filter((node) => textOf(node).length > 20);
      if (nodes.length) return nodes;
    }
    return [];
  }

  function collectTopicContent() {
    const title = getTopicTitle();
    const postNodes = findPostCookedNodes();
    const mainPost = textOf(postNodes[0]);
    const replies = postNodes.slice(1, 6).map((node, index) => `回复 ${index + 1}:\n${clipText(textOf(node), 700)}`);

    const fallback = textOf($('main, #main-outlet, body'));
    const body = mainPost || clipText(fallback, 3500);

    return {
      title,
      url: location.href,
      mainPost: clipText(body, 5000),
      visibleReplies: replies,
    };
  }

  function buildUserMessage(topic) {
    return [
      `帖子标题：${topic.title}`,
      `帖子链接：${topic.url}`,
      '',
      '主帖内容：',
      topic.mainPost || '（未能读取到主帖正文，请基于标题谨慎回复）',
      '',
      topic.visibleReplies.length ? '页面上可见的部分回复：' : '',
      ...topic.visibleReplies,
      '',
      '请直接输出一条可以发布到该帖子的回复正文，不要加标题，不要用 Markdown 包裹。',
    ].filter(Boolean).join('\n');
  }

  function requestChatCompletion(config, topic) {
    const url = `${config.baseUrl}/chat/completions`;
    const payload = {
      model: config.model,
      messages: [
        { role: 'system', content: config.prompt || DEFAULT_PROMPT },
        { role: 'user', content: buildUserMessage(topic) },
      ],
      temperature: 0.7,
      max_tokens: 700,
    };

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        data: JSON.stringify(payload),
        timeout: 60000,
        onload(response) {
          let data;
          try {
            data = JSON.parse(response.responseText || '{}');
          } catch (error) {
            reject(new Error(`接口返回不是 JSON：${response.responseText?.slice(0, 300) || response.status}`));
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            const message = data?.error?.message || data?.message || response.responseText?.slice(0, 500) || `HTTP ${response.status}`;
            reject(new Error(`生成失败：${message}`));
            return;
          }
          const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
          if (!content.trim()) {
            reject(new Error('接口没有返回回复内容'));
            return;
          }
          resolve(content.trim());
        },
        onerror() {
          reject(new Error('网络请求失败，请检查 Base URL、跨域/connect 权限或网络'));
        },
        ontimeout() {
          reject(new Error('请求超时，请稍后重试或换用更快的模型'));
        },
      });
    });
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function clickReplyButton() {
    const candidates = $$('button, .btn, a').filter((el) => {
      const label = `${textOf(el)} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`;
      return /回复|Reply/i.test(label) && !/取消|关闭|cancel|close/i.test(label);
    });
    const topicFooterReply = candidates.find((el) => el.className?.toString().includes('create')) || candidates[candidates.length - 1];
    topicFooterReply?.click();
  }

  async function waitForEditor(timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const textarea = $('textarea.d-editor-input, textarea[placeholder], textarea');
      const contentEditable = $('[contenteditable="true"]');
      if (textarea || contentEditable) return textarea || contentEditable;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  async function fillComposer(reply) {
    let editor = await waitForEditor(800);
    if (!editor) {
      clickReplyButton();
      editor = await waitForEditor(5000);
    }
    if (!editor) return false;

    editor.focus();
    if (editor.matches('textarea, input')) {
      setNativeValue(editor, reply);
    } else {
      editor.textContent = reply;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: reply }));
    }
    return true;
  }

  function ensureStyles() {
    GM_addStyle(`
      #${APP_ID}-button {
        position: fixed;
        right: 20px;
        bottom: 96px;
        z-index: 99999;
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        background: #2563eb;
        color: #fff;
        font-weight: 700;
        box-shadow: 0 8px 24px rgba(15, 23, 42, .24);
        cursor: pointer;
      }
      #${APP_ID}-button:hover { background: #1d4ed8; }
      #${APP_ID}-panel {
        position: fixed;
        right: 20px;
        bottom: 145px;
        width: min(460px, calc(100vw - 32px));
        max-height: min(720px, calc(100vh - 180px));
        overflow: auto;
        z-index: 99999;
        background: var(--secondary, #fff);
        color: var(--primary, #111827);
        border: 1px solid rgba(148, 163, 184, .5);
        border-radius: 14px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, .30);
        padding: 14px;
        font-size: 14px;
      }
      #${APP_ID}-panel.hidden { display: none; }
      #${APP_ID}-panel label { display: block; margin: 10px 0 4px; font-weight: 700; }
      #${APP_ID}-panel input, #${APP_ID}-panel textarea {
        width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px;
        padding: 8px; font: inherit; background: #fff; color: #111827;
      }
      #${APP_ID}-panel textarea { min-height: 92px; resize: vertical; }
      #${APP_ID}-panel .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      #${APP_ID}-panel .row button {
        border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; font-weight: 700;
      }
      #${APP_ID}-generate { background: #16a34a; color: white; }
      #${APP_ID}-save { background: #2563eb; color: white; }
      #${APP_ID}-close, #${APP_ID}-copy { background: #e2e8f0; color: #0f172a; }
      #${APP_ID}-status { margin-top: 10px; white-space: pre-wrap; color: #475569; }
      #${APP_ID}-result { min-height: 120px; }
      #${APP_ID}-panel .checkline { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      #${APP_ID}-panel .checkline input { width: auto; }
    `);
  }

  function renderPanel() {
    const config = getConfig();
    const panel = document.createElement('div');
    panel.id = `${APP_ID}-panel`;
    panel.className = 'hidden';
    panel.innerHTML = `
      <strong>Linux.do AI 回帖助手</strong>
      <label>Base URL</label>
      <input id="${APP_ID}-base-url" placeholder="https://api.example.com/v1" />
      <label>API Key</label>
      <input id="${APP_ID}-api-key" type="password" placeholder="sk-..." />
      <label>Model</label>
      <input id="${APP_ID}-model" placeholder="gpt-4o-mini" />
      <label>提示词</label>
      <textarea id="${APP_ID}-prompt"></textarea>
      <div class="checkline"><input id="${APP_ID}-auto-fill" type="checkbox" /><span>生成后自动打开回复框并填入</span></div>
      <div class="row">
        <button id="${APP_ID}-save">保存配置</button>
        <button id="${APP_ID}-generate">生成回复</button>
        <button id="${APP_ID}-copy">复制结果</button>
        <button id="${APP_ID}-close">关闭</button>
      </div>
      <label>生成结果</label>
      <textarea id="${APP_ID}-result" placeholder="生成的回复会显示在这里"></textarea>
      <div id="${APP_ID}-status"></div>
    `;
    document.body.appendChild(panel);

    $(`#${APP_ID}-base-url`).value = config.baseUrl;
    $(`#${APP_ID}-api-key`).value = config.apiKey;
    $(`#${APP_ID}-model`).value = config.model;
    $(`#${APP_ID}-prompt`).value = config.prompt;
    $(`#${APP_ID}-auto-fill`).checked = Boolean(config.autoFill);

    return panel;
  }

  function readPanelConfig() {
    return {
      baseUrl: $(`#${APP_ID}-base-url`).value,
      apiKey: $(`#${APP_ID}-api-key`).value,
      model: $(`#${APP_ID}-model`).value,
      prompt: $(`#${APP_ID}-prompt`).value,
      autoFill: $(`#${APP_ID}-auto-fill`).checked,
    };
  }

  function setStatus(message, isError = false) {
    const node = $(`#${APP_ID}-status`);
    if (!node) return;
    node.textContent = message;
    node.style.color = isError ? '#dc2626' : '#475569';
  }

  async function generateReply() {
    if (state.busy) return;
    const config = readPanelConfig();
    saveConfig(config);

    if (!config.baseUrl || !config.apiKey || !config.model) {
      setStatus('请先填写 Base URL、API Key 和 Model。', true);
      return;
    }

    state.busy = true;
    setStatus('正在读取帖子内容并请求 AI 生成……');
    try {
      const topic = collectTopicContent();
      const reply = await requestChatCompletion(getConfig(), topic);
      state.lastReply = reply;
      $(`#${APP_ID}-result`).value = reply;
      const copied = await copyToClipboard(reply);
      const filled = config.autoFill ? await fillComposer(reply) : false;
      setStatus([
        '生成完成。',
        copied ? '已复制到剪贴板。' : '剪贴板复制失败，可手动复制结果。',
        config.autoFill ? (filled ? '已尝试填入回复框，请发布前人工检查。' : '未找到回复编辑器，请手动复制粘贴。') : '未启用自动填入。',
      ].join('\n'));
    } catch (error) {
      console.error('[Linux.do AI Reply Assistant]', error);
      setStatus(error?.message || String(error), true);
    } finally {
      state.busy = false;
    }
  }

  function init() {
    if (document.getElementById(`${APP_ID}-button`)) return;
    ensureStyles();
    const panel = renderPanel();
    const button = document.createElement('button');
    button.id = `${APP_ID}-button`;
    button.textContent = 'AI 回帖';
    button.addEventListener('click', () => panel.classList.toggle('hidden'));
    document.body.appendChild(button);

    $(`#${APP_ID}-close`).addEventListener('click', () => panel.classList.add('hidden'));
    $(`#${APP_ID}-save`).addEventListener('click', () => {
      saveConfig(readPanelConfig());
      setStatus('配置已保存。');
    });
    $(`#${APP_ID}-generate`).addEventListener('click', generateReply);
    $(`#${APP_ID}-copy`).addEventListener('click', async () => {
      const text = $(`#${APP_ID}-result`).value || state.lastReply;
      if (!text) return setStatus('当前没有可复制的生成结果。', true);
      setStatus((await copyToClipboard(text)) ? '已复制。' : '复制失败，请手动复制。');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
