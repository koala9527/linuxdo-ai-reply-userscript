// ==UserScript==
// @name         Linux.do AI 回帖助手
// @namespace    https://git.tuwei.space/koala9527/linuxdo-ai-reply-userscript
// @version      0.3.3
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
  const BUILTIN_PROMPT_VERSION = 5;
  const PANEL_SIZE_VERSION = 2;
  const DEFAULT_PANEL_SIZE = { width: 780, height: 880 };
  const MIN_REPLY_COUNT = 1;
  const MAX_REPLY_COUNT = 10;
  const REPLY_BLOCK_RE = /===AI_REPLY_(\d{1,2})===\s*([\s\S]*?)(?=\n?===AI_REPLY_\d{1,2}===|$)/g;
  const DEFAULT_PROMPT = `你是 linux.do 论坛的真实用户。请先理解 linux.do 的社区文化：技术交流、经验分享、玩梗适度、和谐友善，但不鼓励无意义灌水。
请根据帖子内容写一条自然、有帮助的中文回复。
要求：
1. 简洁，不要长篇大论，通常 80-220 字。
2. 语气友好、像真人论坛回复，不要像营销文案或 AI 公告。
3. 对认真分享、有效提问、真实经验，可以给出鼓励、补充或建设性建议。
4. 对明显水贴、破事、情绪化吐槽、伸手党内容，可以温和质疑、轻轻点醒，但不要上纲上线。
5. 不要编造帖子里没有的信息。
6. 不要输出“作为 AI”“免责声明”等套话。`;
  const BUILTIN_PROMPT_TEMPLATES = [
    {
      id: 'tieba-bro',
      title: '贴吧老哥',
      prompt: `你是懂 linux.do 社区文化的贴吧神回复型老哥：知道这里重视技术交流、经验分享、互相帮忙，也容得下适度玩梗；整体保持和谐友善，但遇到明显水贴、破事、伸手党，可以用短句轻轻质疑一下。
请根据帖子内容写一条短、歪、准、有记忆点的中文回复，像能被楼下疯狂引用的评论。
要求：
1. 回复必须短，15-60 字优先，最多 90 字。
2. 对认真内容可以夸一句、抬一手；对纯水/破事可以犀利一点，但要像论坛老哥吐槽，不要恶意攻击。
3. 不要正经长篇解答，优先找一个刁钻角度、反转角度或离谱类比，一句话打中笑点/槽点。
4. 像神评：前半句正常，后半句突然拐弯；或者直接一句话把楼主处境概括成梗。
5. 可以阴阳一点，但不做人身攻击，不骂身份和群体。
6. 少建议、少分析、少“我觉得”；不要客服腔，不要论文腔。
7. 可用“绷不住”“典中典”“这下”“属于是”“味太冲了”等口语，但每条最多用一个梗词。
8. 不编造帖子里没有的信息；只输出正文，不要标题、Markdown、免责声明。`,
    },
    {
      id: 'bilibili-fengge',
      title: 'B站峰哥',
      prompt: `请用一种 B 站现实观察区的“这是好事”式解构口吻回复，但先理解 linux.do 的社区文化：技术交流、经验分享、和谐友善、适度玩梗。不要声称自己是任何真人。
把帖子里的坏事、怪事、离谱事，反向解释成一种社会运行逻辑或个人成长教材。
要求：
1. 开头尽量有“这是好事”或类似反常识判断。
2. 对认真分享和有效提问，要把它解释成社区良性循环；对水贴、破事、伸手党，要解释成筛选机制或现实教育。
3. 用“你看”“说明什么”“本质上”“这就筛掉了”这类解答万物的语气，把问题解释成筛选、教育、祛魅、认清现实。
4. 要有一点反讽和荒诞感，但不要攻击楼主，不要破坏友善氛围。
5. 回复控制在 60-150 字，别铺陈太长。
6. 只输出可直接发布的正文，不要标题、Markdown、免责声明。`,
    },
    {
      id: 'linuxdo-neo-emperor',
      title: 'Neo 始皇',
      prompt: `你是 linux.do 的 Neo 始皇式老用户，理解这里的社区文化：重视技术、经验、互助，也允许适度玩梗；整体和谐友善，但对无意义水贴、破事、伸手党要有判断。
请根据帖子内容写一条有威仪、有判断、有社区味的回复，不要太客观，不要过分礼貌，像是在御前定调。
要求：
1. 先给明确态度，别两边都对，别写成客服回复。
2. 对认真分享、有效提问、优质经验，可以给“当赏”式鼓励；对破事水贴，可以轻压一下，点到为止。
3. 可以带一点“准了”“此事可议”“朕以为”“当赏/当斩”的轻梗，但不要满篇角色扮演。
4. 保留技术社区的判断力：该指出问题就指出，该给方向就给方向。
5. 回复控制在 50-140 字，简洁有力。
6. 不编造帖子里没有的信息；只输出正文，不要标题、Markdown、免责声明。`,
    },
  ];
  const MAX_PROMPT_TEMPLATES = 5;

  const state = {
    busy: false,
    lastReply: '',
    lastReplies: [],
    promptTemplates: [],
    activePromptTemplateId: '',
    lastAutoGenerateTopicKey: '',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function normalizeBaseUrl(baseUrl) {
    return (baseUrl || '').trim().replace(/\/+$/, '');
  }

  function buildChatCompletionsUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return '';
    if (/\/chat\/completions(?:[?#].*)?$/i.test(normalized)) return normalized;
    return `${normalized}/chat/completions`;
  }

  function summarizeResponseBody(body, maxLength = 500) {
    return (body || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function maskUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      const pathHint = /\/chat\/completions/i.test(url.pathname)
        ? '/chat/completions'
        : (/\/v1(?:\/|$)/i.test(url.pathname) ? '/v1/...' : '/...');
      return `${url.protocol}//***${pathHint}`;
    } catch (_) {
      return raw.replace(/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[\w./?&=%:-]*/g, '***');
    }
  }

  function maskSecretValue(value) {
    const text = String(value || '');
    if (!text) return '';
    if (text.length <= 8) return '*'.repeat(text.length);
    return `${text.slice(0, 3)}${'*'.repeat(Math.min(12, text.length - 6))}${text.slice(-3)}`;
  }

  function sanitizeLogMessage(message) {
    let text = String(message || '');
    const config = getConfig();
    const urls = [
      config.baseUrl,
      buildChatCompletionsUrl(config.baseUrl),
      $(`#${APP_ID}-base-url`)?.value,
      buildChatCompletionsUrl($(`#${APP_ID}-base-url`)?.value || ''),
    ].filter(Boolean);
    const keys = [config.apiKey, $(`#${APP_ID}-api-key`)?.value].filter(Boolean);

    for (const url of urls) {
      text = text.split(url).join(maskUrl(url));
    }
    text = text.replace(/https?:\/\/[^\s'"<>]+/gi, (url) => maskUrl(url));
    for (const key of keys) {
      text = text.split(key).join(maskSecretValue(key));
    }
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
    return text;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function describeApiError(response, data, url) {
    const bodySummary = summarizeResponseBody(response.responseText);
    const message = data?.error?.message || data?.message;
    if (message) return `生成失败：${message}`;

    if (/service temporarily unavailable/i.test(bodySummary)) {
      return [
        '中转站返回 Service temporarily unavailable，通常是中转站临时不可用、上游线路异常或当前模型不可用。',
        `当前请求地址：${maskUrl(url)}`,
        '请稍后重试，或在中转站控制台确认该模型/线路可用、余额正常。',
      ].join('\n');
    }

    if (/^\s*</.test(response.responseText || '')) {
      return [
        `接口返回了网页 HTML，不是 OpenAI JSON。当前请求地址：${maskUrl(url)}`,
        '请确认 Base URL 填的是中转站 API 入口，不是控制台/官网首页；OpenAI 兼容地址通常应能拼成 /v1/chat/completions。',
        bodySummary ? '返回片段已隐藏，避免暴露中转站信息。' : '',
      ].filter(Boolean).join('\n');
    }

    const status = response.status ? `HTTP ${response.status}` : '请求失败';
    return `生成失败：${status}\n当前请求地址：${maskUrl(url)}${bodySummary ? '\n返回内容已隐藏，避免暴露中转站信息。' : ''}`;
  }

  function getRequestUrlHint(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return '';

    const requestUrl = buildChatCompletionsUrl(normalized);
    const hint = [`实际请求地址：${maskUrl(requestUrl)}`];
    if (!/\/(?:v1|chat\/completions)(?:[/?#]|$)/i.test(normalized)) {
      hint.push('如果你的中转站是 OpenAI 兼容接口，Base URL 通常需要填到 /v1。');
    }
    return hint.join('\n');
  }

  function getPanelSize() {
    const version = Number(GM_getValue('panelSizeVersion', 0));
    const useStoredSize = version >= PANEL_SIZE_VERSION;
    return {
      width: useStoredSize ? Number(GM_getValue('panelWidth', DEFAULT_PANEL_SIZE.width)) || DEFAULT_PANEL_SIZE.width : DEFAULT_PANEL_SIZE.width,
      height: useStoredSize ? Number(GM_getValue('panelHeight', DEFAULT_PANEL_SIZE.height)) || DEFAULT_PANEL_SIZE.height : DEFAULT_PANEL_SIZE.height,
    };
  }

  function applyPanelSize(panel) {
    const size = getPanelSize();
    panel.style.width = `${Math.min(Math.max(size.width, 460), window.innerWidth - 24)}px`;
    panel.style.height = `${Math.min(Math.max(size.height, 620), window.innerHeight - 48)}px`;
  }

  function rememberPanelSize(panel) {
    const rect = panel.getBoundingClientRect();
    GM_setValue('panelWidth', Math.round(rect.width));
    GM_setValue('panelHeight', Math.round(rect.height));
    GM_setValue('panelSizeVersion', PANEL_SIZE_VERSION);
  }

  function attachPanelResizeHandle(panel) {
    const handle = $(`#${APP_ID}-resize-handle`, panel);
    if (!handle) return;
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = rect.width;
      const startHeight = rect.height;

      const move = (moveEvent) => {
        const width = Math.min(Math.max(startWidth + moveEvent.clientX - startX, 460), window.innerWidth - 24);
        const height = Math.min(Math.max(startHeight + moveEvent.clientY - startY, 620), window.innerHeight - 48);
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
      };
      const stop = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', stop);
        rememberPanelSize(panel);
      };

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', stop);
    });
  }

  function toggleSecretInput(inputId, buttonId) {
    const input = $(`#${inputId}`);
    const button = $(`#${buttonId}`);
    if (!input || !button) return;
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    button.textContent = hidden ? '隐藏' : '显示';
    button.setAttribute('aria-label', hidden ? '隐藏内容' : '显示内容');
  }

  function clampReplyCount(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return MIN_REPLY_COUNT;
    return Math.min(Math.max(number, MIN_REPLY_COUNT), MAX_REPLY_COUNT);
  }

  function extractReplyBlocks(rawText, expectedCount) {
    const replies = [];
    REPLY_BLOCK_RE.lastIndex = 0;
    let match;
    while ((match = REPLY_BLOCK_RE.exec(rawText || ''))) {
      const index = Number.parseInt(match[1], 10);
      const content = (match[2] || '').trim();
      if (index >= MIN_REPLY_COUNT && index <= MAX_REPLY_COUNT && content) {
        replies[index - 1] = content;
      }
    }

    return replies.filter(Boolean).slice(0, expectedCount);
  }

  function formatRepliesForCopy(replies) {
    return replies.map((reply, index) => `${index + 1}. ${reply}`).join('\n\n');
  }

  function renderReplyCards(replies) {
    const list = $(`#${APP_ID}-reply-list`);
    if (!list) return;
    if (!replies.length) {
      list.innerHTML = '<div class="reply-empty">生成后会按条展示，每条都可以单独复制。</div>';
      return;
    }

    list.innerHTML = replies.map((reply, index) => `
      <div class="reply-card">
        <div class="reply-card-head">
          <strong>候选 ${index + 1}</strong>
          <button type="button" data-copy-reply-index="${index}">复制这一条</button>
        </div>
        <textarea id="${APP_ID}-reply-${index}" spellcheck="false">${escapeHtml(reply)}</textarea>
      </div>
    `).join('');
  }

  function getReplyTextByIndex(index) {
    const textarea = $(`#${APP_ID}-reply-${index}`);
    return (textarea?.value || state.lastReplies[index] || '').trim();
  }

  function getCurrentReplyTexts() {
    const fromDom = $$(`#${APP_ID}-reply-list textarea`)
      .map((textarea) => textarea.value.trim())
      .filter(Boolean);
    return fromDom.length ? fromDom : state.lastReplies.filter(Boolean);
  }

  function clonePromptTemplate(template) {
    return { ...template };
  }

  function getBuiltinPromptTemplate(id) {
    return BUILTIN_PROMPT_TEMPLATES.find((template) => template.id === id);
  }

  function readStoredPromptTemplates() {
    const raw = GM_getValue('promptTemplates', null);
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function shouldRefreshBuiltinPromptTemplates() {
    return Number(GM_getValue('builtinPromptVersion', 0)) < BUILTIN_PROMPT_VERSION;
  }

  function normalizePromptTemplates() {
    const stored = readStoredPromptTemplates();
    const storedById = new Map(stored.filter((item) => item?.id).map((item) => [item.id, item]));
    const legacyPrompt = (GM_getValue('prompt', '') || '').trim();
    const refreshBuiltins = shouldRefreshBuiltinPromptTemplates();

    const builtins = BUILTIN_PROMPT_TEMPLATES.map((builtin) => {
      const storedTemplate = storedById.get(builtin.id);
      const prompt = !refreshBuiltins && typeof storedTemplate?.prompt === 'string' && storedTemplate.prompt.trim()
        ? storedTemplate.prompt
        : builtin.prompt;
      const title = !refreshBuiltins && typeof storedTemplate?.title === 'string' && storedTemplate.title.trim()
        ? storedTemplate.title.trim()
        : builtin.title;
      return {
        id: builtin.id,
        title,
        prompt,
        builtin: true,
      };
    });

    const custom = stored
      .filter((item) => item && !getBuiltinPromptTemplate(item.id))
      .map((item) => ({
        id: item.id || `custom-${Date.now()}`,
        title: (item.title || '').trim(),
        prompt: item.prompt || '',
        builtin: false,
      }))
      .filter((item) => item.title && item.prompt.trim())
      .slice(0, Math.max(0, MAX_PROMPT_TEMPLATES - builtins.length));

    if (
      legacyPrompt
      && legacyPrompt !== DEFAULT_PROMPT.trim()
      && !stored.length
      && custom.length < MAX_PROMPT_TEMPLATES - builtins.length
    ) {
      custom.unshift({
        id: 'custom-legacy-prompt',
        title: '旧提示词',
        prompt: legacyPrompt,
        builtin: false,
      });
    }

    return [...builtins, ...custom.slice(0, Math.max(0, MAX_PROMPT_TEMPLATES - builtins.length))];
  }

  function savePromptTemplates(templates) {
    const normalized = templates
      .map((template) => ({
        id: template.id,
        title: (template.title || '').trim(),
        prompt: template.prompt || '',
        builtin: Boolean(template.builtin),
      }))
      .filter((template) => template.id && template.title && template.prompt.trim())
      .slice(0, MAX_PROMPT_TEMPLATES);
    GM_setValue('promptTemplates', JSON.stringify(normalized));
  }

  function getActivePromptTemplateId(templates) {
    const storedId = GM_getValue('activePromptTemplateId', '');
    if (templates.some((template) => template.id === storedId)) return storedId;
    return templates[0]?.id || BUILTIN_PROMPT_TEMPLATES[0].id;
  }

  function getActivePromptTemplate(templates = state.promptTemplates) {
    return templates.find((template) => template.id === state.activePromptTemplateId) || templates[0];
  }

  function syncPromptDraftFromPanel() {
    const active = getActivePromptTemplate();
    const titleInput = $(`#${APP_ID}-prompt-title`);
    const promptInput = $(`#${APP_ID}-prompt`);
    if (!active || !titleInput || !promptInput) return;
    active.title = titleInput.value.trim();
    active.prompt = promptInput.value;
  }

  function validatePromptTemplates(templates) {
    for (const template of templates) {
      if (!template.title.trim()) return '提示词模板标题不能为空。';
      if (!template.prompt.trim()) return '提示词模板内容不能为空。';
      if (!template.builtin && (!template.title.trim() || !template.prompt.trim())) {
        return '自定义模板必须填写非空标题和非空提示词才可以保存。';
      }
    }
    return '';
  }

  function persistActivePromptTemplateId(id) {
    state.activePromptTemplateId = id;
    GM_setValue('activePromptTemplateId', id);
  }

  function renderPromptTabs() {
    const tabs = $(`#${APP_ID}-prompt-tabs`);
    if (!tabs) return;
    tabs.innerHTML = state.promptTemplates.map((template, index) => {
      const isActive = template.id === state.activePromptTemplateId;
      const badge = template.builtin ? '预设' : '自定义';
      return `
        <button
          type="button"
          class="${isActive ? 'active' : ''}"
          data-template-id="${escapeHtml(template.id)}"
          title="${escapeHtml(template.title)}"
        >
          <span>${index + 1}. ${escapeHtml(template.title || '未命名')}</span>
          <small>${badge}</small>
        </button>
      `;
    }).join('');
  }

  function renderPromptEditor() {
    const active = getActivePromptTemplate();
    const titleInput = $(`#${APP_ID}-prompt-title`);
    const promptInput = $(`#${APP_ID}-prompt`);
    const meta = $(`#${APP_ID}-prompt-meta`);
    const resetButton = $(`#${APP_ID}-reset-template`);
    const deleteButton = $(`#${APP_ID}-delete-template`);
    if (!active || !titleInput || !promptInput || !meta) return;

    titleInput.value = active.title;
    promptInput.value = active.prompt;
    meta.textContent = active.builtin ? '前 3 个预设可修改、可重置、不可删除。' : '自定义模板可修改，可删除。';
    if (resetButton) resetButton.disabled = !active.builtin;
    if (deleteButton) deleteButton.disabled = active.builtin;
    renderPromptTabs();
  }

  function switchPromptTemplate(id) {
    syncPromptDraftFromPanel();
    if (!state.promptTemplates.some((template) => template.id === id)) return;
    persistActivePromptTemplateId(id);
    renderPromptEditor();
  }

  function addCustomPromptTemplate() {
    syncPromptDraftFromPanel();
    const customCount = state.promptTemplates.filter((template) => !template.builtin).length;
    const maxCustom = MAX_PROMPT_TEMPLATES - BUILTIN_PROMPT_TEMPLATES.length;
    if (customCount >= maxCustom) {
      setStatus(`最多保存 ${MAX_PROMPT_TEMPLATES} 组模板：3 组预设 + ${maxCustom} 组自定义。`, true);
      return;
    }

    const template = {
      id: `custom-${Date.now()}`,
      title: `自定义 ${customCount + 1}`,
      prompt: '请根据帖子内容写一条自然、有帮助、适合发布到 linux.do 的中文回复。不要声明自己是 AI，不要加标题。',
      builtin: false,
    };
    state.promptTemplates.push(template);
    persistActivePromptTemplateId(template.id);
    renderPromptEditor();
    setStatus('已添加自定义模板，保存前请确认标题和提示词都不为空。');
  }

  function resetActiveBuiltinTemplate() {
    syncPromptDraftFromPanel();
    const active = getActivePromptTemplate();
    const builtin = active && getBuiltinPromptTemplate(active.id);
    if (!active || !builtin) return;
    Object.assign(active, clonePromptTemplate({ ...builtin, builtin: true }));
    renderPromptEditor();
    setStatus('当前预设已重置为默认提示词。');
  }

  function deleteActiveCustomTemplate() {
    syncPromptDraftFromPanel();
    const active = getActivePromptTemplate();
    if (!active || active.builtin) return;
    state.promptTemplates = state.promptTemplates.filter((template) => template.id !== active.id);
    persistActivePromptTemplateId(state.promptTemplates[0]?.id || BUILTIN_PROMPT_TEMPLATES[0].id);
    renderPromptEditor();
    setStatus('自定义模板已删除。');
  }

  function getConfig() {
    const templates = normalizePromptTemplates();
    const activeId = getActivePromptTemplateId(templates);
    const activeTemplate = templates.find((template) => template.id === activeId) || templates[0];
    return {
      baseUrl: normalizeBaseUrl(GM_getValue('baseUrl', '')),
      apiKey: GM_getValue('apiKey', '') || '',
      model: (GM_getValue('model', 'gpt-4o-mini') || 'gpt-4o-mini').trim(),
      replyCount: clampReplyCount(GM_getValue('replyCount', 1)),
      autoGenerate: Boolean(GM_getValue('autoGenerate', false)),
      prompt: activeTemplate?.prompt || DEFAULT_PROMPT,
      activePromptTemplateId: activeTemplate?.id || BUILTIN_PROMPT_TEMPLATES[0].id,
      promptTemplates: templates,
    };
  }

  function saveConfig(config) {
    GM_setValue('baseUrl', normalizeBaseUrl(config.baseUrl));
    GM_setValue('apiKey', config.apiKey || '');
    GM_setValue('model', (config.model || '').trim() || 'gpt-4o-mini');
    GM_setValue('replyCount', clampReplyCount(config.replyCount));
    GM_setValue('autoGenerate', Boolean(config.autoGenerate));
    GM_setValue('prompt', config.prompt || DEFAULT_PROMPT);
    if (config.promptTemplates) savePromptTemplates(config.promptTemplates);
    if (config.activePromptTemplateId) persistActivePromptTemplateId(config.activePromptTemplateId);
    GM_setValue('builtinPromptVersion', BUILTIN_PROMPT_VERSION);
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

  function buildUserMessage(topic, replyCount) {
    const count = clampReplyCount(replyCount);
    const formatLines = Array.from({ length: count }, (_, index) => [
      `===AI_REPLY_${index + 1}===`,
      `第 ${index + 1} 条回复正文`,
    ].join('\n'));

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
      `请生成 ${count} 条可发布到该帖子的候选回复。`,
      '必须严格使用下面的固定格式输出，不要添加解释、标题、Markdown、代码块或额外文字：',
      '',
      ...formatLines,
    ].filter(Boolean).join('\n');
  }

  function requestChatCompletion(config, topic) {
    const url = buildChatCompletionsUrl(config.baseUrl);
    const payload = {
      model: config.model,
      messages: [
        { role: 'system', content: config.prompt || DEFAULT_PROMPT },
        { role: 'user', content: buildUserMessage(topic, config.replyCount) },
      ],
      temperature: 0.7,
      max_tokens: Math.max(700, clampReplyCount(config.replyCount) * 180),
    };

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        data: JSON.stringify(payload),
        timeout: 60000,
        onload(response) {
          let data;
          try {
            data = JSON.parse(response.responseText || '{}');
          } catch (error) {
            reject(new Error(describeApiError(response, null, url)));
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(describeApiError(response, data, url)));
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

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
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
        padding: 11px 16px;
        background: linear-gradient(135deg, #14532d, #2563eb);
        color: #fff;
        font-weight: 700;
        box-shadow: 0 12px 30px rgba(15, 23, 42, .26);
        cursor: pointer;
      }
      #${APP_ID}-button:hover { filter: brightness(1.05); }
      #${APP_ID}-panel {
        position: fixed;
        right: 12px;
        bottom: 84px;
        width: min(720px, calc(100vw - 32px));
        height: min(880px, calc(100vh - 48px));
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 48px);
        min-width: min(460px, calc(100vw - 24px));
        min-height: 620px;
        overflow: auto;
        resize: both;
        z-index: 99999;
        background: #f8fafc;
        color: #111827;
        border: 1px solid rgba(51, 65, 85, .18);
        border-radius: 12px;
        box-shadow: 0 22px 70px rgba(15, 23, 42, .34);
        padding: 18px;
        font-size: 14px;
      }
      #${APP_ID}-panel.hidden { display: none; }
      #${APP_ID}-panel .panel-head {
        display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px;
      }
      #${APP_ID}-panel .panel-title { font-size: 17px; font-weight: 800; letter-spacing: 0; }
      #${APP_ID}-panel .panel-subtitle { color: #64748b; font-size: 12px; margin-top: 2px; }
      #${APP_ID}-panel .section {
        background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-top: 12px;
      }
      #${APP_ID}-panel .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #${APP_ID}-panel .grid .wide { grid-column: 1 / -1; }
      #${APP_ID}-panel label { display: block; margin: 0 0 5px; font-weight: 700; color: #334155; }
      #${APP_ID}-panel .field-with-button { display: flex; gap: 8px; align-items: stretch; }
      #${APP_ID}-panel .field-with-button input { min-width: 0; }
      #${APP_ID}-panel .field-with-button button {
        border: 0; border-radius: 8px; padding: 0 10px; cursor: pointer; font-weight: 700;
        background: #e2e8f0; color: #0f172a; white-space: nowrap;
      }
      #${APP_ID}-panel input, #${APP_ID}-panel textarea {
        width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px;
        padding: 9px 10px; font: inherit; background: #fff; color: #111827; outline: none;
      }
      #${APP_ID}-panel input:focus, #${APP_ID}-panel textarea:focus {
        border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
      }
      #${APP_ID}-panel textarea { min-height: 112px; resize: vertical; line-height: 1.55; }
      #${APP_ID}-prompt { min-height: 220px; }
      #${APP_ID}-panel .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
      #${APP_ID}-panel .row button {
        border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer; font-weight: 700;
      }
      #${APP_ID}-panel button:disabled { cursor: not-allowed; opacity: .45; }
      #${APP_ID}-generate { background: #16a34a; color: white; }
      #${APP_ID}-save { background: #2563eb; color: white; }
      #${APP_ID}-close, #${APP_ID}-copy, #${APP_ID}-add-template, #${APP_ID}-reset-template, #${APP_ID}-delete-template {
        background: #e2e8f0; color: #0f172a;
      }
      #${APP_ID}-delete-template:not(:disabled) { background: #fee2e2; color: #991b1b; }
      #${APP_ID}-status { margin-top: 10px; white-space: pre-wrap; color: #475569; }
      #${APP_ID}-format-note { color: #64748b; font-size: 12px; margin-top: 8px; }
      #${APP_ID}-reply-list { display: grid; gap: 10px; margin-top: 8px; }
      #${APP_ID}-reply-list .reply-empty {
        color: #64748b; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px;
        padding: 18px; text-align: center;
      }
      #${APP_ID}-reply-list .reply-card {
        border: 1px solid #dbe3ea; border-radius: 10px; background: #f8fafc; padding: 10px;
      }
      #${APP_ID}-reply-list .reply-card-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px;
      }
      #${APP_ID}-reply-list .reply-card-head strong { color: #0f172a; }
      #${APP_ID}-reply-list .reply-card-head button {
        border: 0; border-radius: 8px; padding: 7px 10px; cursor: pointer; font-weight: 700;
        background: #dcfce7; color: #166534; white-space: nowrap;
      }
      #${APP_ID}-reply-list textarea {
        min-height: 92px; resize: vertical; background: #fff;
      }
      #${APP_ID}-panel .checkline { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      #${APP_ID}-panel .checkline input { width: auto; }
      #${APP_ID}-panel .switchline {
        display: flex; align-items: center; justify-content: space-between; gap: 14px;
        margin-top: 12px; padding: 11px 12px; border: 1px solid #dbe3ea; border-radius: 10px; background: #f8fafc;
      }
      #${APP_ID}-panel .switchline strong { display: block; color: #0f172a; }
      #${APP_ID}-panel .switchline span { display: block; color: #64748b; font-size: 12px; margin-top: 2px; }
      #${APP_ID}-panel .switchline input {
        appearance: none; width: 46px; height: 26px; flex: 0 0 auto; cursor: pointer;
        border: 0; border-radius: 999px; background: #cbd5e1; padding: 3px; position: relative;
      }
      #${APP_ID}-panel .switchline input::before {
        content: ""; position: absolute; left: 3px; top: 3px; width: 20px; height: 20px;
        border-radius: 999px; background: #fff; box-shadow: 0 1px 4px rgba(15, 23, 42, .25);
        transition: transform .16s ease;
      }
      #${APP_ID}-panel .switchline input:checked { background: #16a34a; }
      #${APP_ID}-panel .switchline input:checked::before { transform: translateX(20px); }
      #${APP_ID}-resize-handle {
        position: sticky; left: 100%; bottom: 0; width: 22px; height: 22px; margin: 8px -8px -10px auto;
        border-radius: 6px; cursor: nwse-resize;
        background:
          linear-gradient(135deg, transparent 45%, #94a3b8 46%, #94a3b8 54%, transparent 55%),
          linear-gradient(135deg, transparent 62%, #cbd5e1 63%, #cbd5e1 70%, transparent 71%);
      }
      #${APP_ID}-prompt-tabs {
        display: flex; gap: 8px; flex-wrap: wrap; margin: 2px 0 12px;
      }
      #${APP_ID}-prompt-tabs button {
        border: 1px solid #cbd5e1; background: #f8fafc; color: #334155; border-radius: 999px;
        padding: 7px 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
        max-width: 170px;
      }
      #${APP_ID}-prompt-tabs button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${APP_ID}-prompt-tabs button small {
        color: #64748b; font-size: 11px; font-weight: 700;
      }
      #${APP_ID}-prompt-tabs button.active {
        border-color: #14532d; background: #dcfce7; color: #14532d;
      }
      #${APP_ID}-prompt-meta { color: #64748b; font-size: 12px; margin-top: 8px; }
      @media (max-width: 640px) {
        #${APP_ID}-panel { right: 12px; bottom: 96px; padding: 14px; min-height: 560px; }
        #${APP_ID}-panel .grid { grid-template-columns: 1fr; }
      }
    `);
  }

  function renderPanel() {
    const config = getConfig();
    state.promptTemplates = config.promptTemplates.map(clonePromptTemplate);
    state.activePromptTemplateId = config.activePromptTemplateId;

    const panel = document.createElement('div');
    panel.id = `${APP_ID}-panel`;
    panel.className = 'hidden';
    panel.innerHTML = `
      <div class="panel-head">
        <div>
          <div class="panel-title">Linux.do AI 回帖助手</div>
          <div class="panel-subtitle">OpenAI 兼容接口 · 可切换提示词模板</div>
        </div>
        <button id="${APP_ID}-close" type="button">关闭</button>
      </div>

      <div class="section">
        <div class="grid">
          <div class="wide">
            <label>Base URL</label>
            <div class="field-with-button">
              <input id="${APP_ID}-base-url" type="password" placeholder="https://api.example.com/v1" />
              <button id="${APP_ID}-base-url-toggle" type="button">显示</button>
            </div>
          </div>
          <div>
            <label>API Key</label>
            <div class="field-with-button">
              <input id="${APP_ID}-api-key" type="password" placeholder="sk-..." />
              <button id="${APP_ID}-api-key-toggle" type="button">显示</button>
            </div>
          </div>
          <div>
            <label>Model</label>
            <input id="${APP_ID}-model" placeholder="gpt-4o-mini" />
          </div>
          <div>
            <label>回复个数</label>
            <input id="${APP_ID}-reply-count" type="number" min="1" max="10" step="1" placeholder="1-10" />
          </div>
        </div>
        <label class="switchline" for="${APP_ID}-auto-generate">
          <div>
            <strong>进入帖子自动生成</strong>
            <span>打开后识别到新帖子会立即生成候选回复，仍然只复制不打开回帖框。</span>
          </div>
          <input id="${APP_ID}-auto-generate" type="checkbox" />
        </label>
      </div>

      <div class="section">
        <label>提示词模板</label>
        <div id="${APP_ID}-prompt-tabs"></div>
        <div class="grid">
          <div class="wide">
            <label>模板标题</label>
            <input id="${APP_ID}-prompt-title" placeholder="模板标题不能为空" />
          </div>
          <div class="wide">
            <label>提示词</label>
            <textarea id="${APP_ID}-prompt" placeholder="提示词不能为空"></textarea>
          </div>
        </div>
        <div id="${APP_ID}-prompt-meta"></div>
        <div class="row">
          <button id="${APP_ID}-add-template" type="button">添加自定义</button>
          <button id="${APP_ID}-reset-template" type="button">重置预设</button>
          <button id="${APP_ID}-delete-template" type="button">删除自定义</button>
        </div>
      </div>

      <div class="section">
        <div class="row">
          <button id="${APP_ID}-save" type="button">保存配置</button>
          <button id="${APP_ID}-generate" type="button">生成回复</button>
          <button id="${APP_ID}-copy" type="button">复制全部</button>
        </div>
        <label style="margin-top: 12px;">候选回复</label>
        <div id="${APP_ID}-reply-list">
          <div class="reply-empty">生成后会按条展示，每条都可以单独复制。</div>
        </div>
        <div id="${APP_ID}-format-note">模型会按 ===AI_REPLY_序号=== 固定格式输出，脚本只提取这些块用于复制。</div>
        <div id="${APP_ID}-status"></div>
      </div>
      <div id="${APP_ID}-resize-handle" title="拖拽调整面板大小"></div>
    `;
    document.body.appendChild(panel);
    applyPanelSize(panel);

    $(`#${APP_ID}-base-url`).value = config.baseUrl;
    $(`#${APP_ID}-api-key`).value = config.apiKey;
    $(`#${APP_ID}-model`).value = config.model;
    $(`#${APP_ID}-reply-count`).value = config.replyCount;
    $(`#${APP_ID}-auto-generate`).checked = config.autoGenerate;
    renderPromptEditor();

    return panel;
  }

  function readPanelConfig() {
    syncPromptDraftFromPanel();
    const activeTemplate = getActivePromptTemplate();
    return {
      baseUrl: $(`#${APP_ID}-base-url`).value,
      apiKey: $(`#${APP_ID}-api-key`).value,
      model: $(`#${APP_ID}-model`).value,
      replyCount: clampReplyCount($(`#${APP_ID}-reply-count`).value),
      autoGenerate: $(`#${APP_ID}-auto-generate`).checked,
      prompt: activeTemplate?.prompt || '',
      activePromptTemplateId: activeTemplate?.id || state.activePromptTemplateId,
      promptTemplates: state.promptTemplates.map(clonePromptTemplate),
    };
  }

  function setStatus(message, isError = false) {
    const node = $(`#${APP_ID}-status`);
    if (!node) return;
    node.textContent = sanitizeLogMessage(message);
    node.style.color = isError ? '#dc2626' : '#475569';
  }

  function getTopicIdFromPath(pathname) {
    const segments = String(pathname || '').split('/').filter(Boolean);
    if (segments[0] !== 't') return '';

    const numericSegments = segments.filter((segment) => /^\d+$/.test(segment));
    return numericSegments.length ? numericSegments[0] : '';
  }

  function getAutoGenerateTopicKey() {
    const topicId = getTopicIdFromPath(location.pathname);
    return topicId ? `topic:${topicId}` : '';
  }

  function setLauncherState(label) {
    const button = $(`#${APP_ID}-button`);
    if (button) button.textContent = label;
  }

  async function generateReply(options = {}) {
    if (state.busy) return;
    const isAuto = Boolean(options.auto);
    const config = readPanelConfig();
    const templateError = validatePromptTemplates(config.promptTemplates);
    if (templateError) {
      setStatus(templateError, true);
      return;
    }

    if (!config.baseUrl || !config.apiKey || !config.model) {
      setStatus('请先填写 Base URL、API Key 和 Model。', true);
      return;
    }
    saveConfig(config);

    state.busy = true;
    setLauncherState(isAuto ? 'AI 回帖 · 生成中' : 'AI 回帖');
    setStatus(`${isAuto ? '已识别到新帖子，正在自动生成候选回复……' : '正在读取帖子内容并请求 AI 生成……'}\n${getRequestUrlHint(config.baseUrl)}`);
    try {
      const topic = collectTopicContent();
      const rawReply = await requestChatCompletion(config, topic);
      const replies = extractReplyBlocks(rawReply, config.replyCount);
      if (!replies.length) {
        throw new Error('模型没有按固定格式返回回复，请重试或调整提示词。');
      }
      const formattedReply = formatRepliesForCopy(replies);
      state.lastReply = formattedReply;
      state.lastReplies = replies.slice();
      renderReplyCards(replies);
      const copied = isAuto ? false : await copyToClipboard(formattedReply);
      setLauncherState('AI 回帖 · 已生成');
      setStatus([
        `生成完成，已提取 ${replies.length}/${config.replyCount} 条候选回复。`,
        isAuto ? '自动生成不会改写剪贴板，需要时复制单条或复制全部。' : (copied ? '已复制全部候选回复到剪贴板。' : '剪贴板复制失败，可手动复制结果。'),
        replies.length < config.replyCount ? '模型返回数量不足，可重新生成一次。' : '',
      ].join('\n'));
    } catch (error) {
      console.error('[Linux.do AI 回帖助手]', error);
      setStatus(error?.message || String(error), true);
      setLauncherState('AI 回帖');
    } finally {
      state.busy = false;
    }
  }

  function maybeAutoGenerate() {
    const config = getConfig();
    if (!config.autoGenerate) return;
    if (!config.baseUrl || !config.apiKey || !config.model) return;

    const topicKey = getAutoGenerateTopicKey();
    if (!topicKey) return;
    if (state.lastAutoGenerateTopicKey === topicKey) return;
    state.lastAutoGenerateTopicKey = topicKey;
    setTimeout(() => generateReply({ auto: true }), 900);
  }

  function watchTopicNavigation(onChange) {
    let current = getAutoGenerateTopicKey();
    const notify = () => {
      const next = getAutoGenerateTopicKey();
      if (next === current) return;
      current = next;
      state.lastReply = '';
      state.lastReplies = [];
      renderReplyCards([]);
      setLauncherState('AI 回帖');
      if (!next) return;
      setTimeout(onChange, 700);
    };

    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(notify, 0);
        return result;
      };
    }
    window.addEventListener('popstate', notify);
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
    $(`#${APP_ID}-base-url-toggle`).addEventListener('click', () => {
      toggleSecretInput(`${APP_ID}-base-url`, `${APP_ID}-base-url-toggle`);
    });
    $(`#${APP_ID}-api-key-toggle`).addEventListener('click', () => {
      toggleSecretInput(`${APP_ID}-api-key`, `${APP_ID}-api-key-toggle`);
    });
    $(`#${APP_ID}-reply-count`).addEventListener('change', (event) => {
      event.target.value = clampReplyCount(event.target.value);
    });
    $(`#${APP_ID}-auto-generate`).addEventListener('change', (event) => {
      const config = readPanelConfig();
      saveConfig(config);
      if (event.target.checked) {
        setStatus('已开启进入帖子自动生成。');
        state.lastAutoGenerateTopicKey = '';
        maybeAutoGenerate();
      } else {
        setStatus('已关闭进入帖子自动生成。');
      }
    });
    attachPanelResizeHandle(panel);
    new ResizeObserver(() => rememberPanelSize(panel)).observe(panel);
    $(`#${APP_ID}-save`).addEventListener('click', () => {
      const config = readPanelConfig();
      const templateError = validatePromptTemplates(config.promptTemplates);
      if (templateError) {
        setStatus(templateError, true);
        return;
      }
      saveConfig(config);
      setStatus('配置已保存。');
    });
    $(`#${APP_ID}-prompt-tabs`).addEventListener('click', (event) => {
      const tab = event.target.closest('button[data-template-id]');
      if (tab) switchPromptTemplate(tab.dataset.templateId);
    });
    $(`#${APP_ID}-prompt-title`).addEventListener('input', () => {
      syncPromptDraftFromPanel();
      renderPromptTabs();
    });
    $(`#${APP_ID}-prompt`).addEventListener('input', syncPromptDraftFromPanel);
    $(`#${APP_ID}-add-template`).addEventListener('click', addCustomPromptTemplate);
    $(`#${APP_ID}-reset-template`).addEventListener('click', resetActiveBuiltinTemplate);
    $(`#${APP_ID}-delete-template`).addEventListener('click', deleteActiveCustomTemplate);
    $(`#${APP_ID}-generate`).addEventListener('click', generateReply);
    $(`#${APP_ID}-reply-list`).addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-copy-reply-index]');
      if (!button) return;
      const index = Number.parseInt(button.dataset.copyReplyIndex, 10);
      const text = getReplyTextByIndex(index);
      if (!text) return setStatus('这一条候选回复为空，无法复制。', true);
      setStatus((await copyToClipboard(text)) ? `已复制候选 ${index + 1}。` : '复制失败，请手动复制。');
    });
    $(`#${APP_ID}-copy`).addEventListener('click', async () => {
      const replies = getCurrentReplyTexts();
      const text = replies.length ? formatRepliesForCopy(replies) : state.lastReply;
      if (!text) return setStatus('当前没有可复制的生成结果。', true);
      setStatus((await copyToClipboard(text)) ? `已复制全部 ${replies.length || state.lastReplies.length} 条候选回复。` : '复制失败，请手动复制。');
    });
    watchTopicNavigation(maybeAutoGenerate);
    maybeAutoGenerate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
