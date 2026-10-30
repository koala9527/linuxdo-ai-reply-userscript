// ==UserScript==
// @name         Linux.do 有一说一 · 回帖助手
// @namespace    https://github.com/koala9527/linuxdo-ai-reply-userscript
// @version      1.0.0
// @description  在 linux.do 帖子页自动把「标题 + 本页内容」交给本地「有一说一」服务，生成一条可直接复制的回复；有结果时右下角按钮变色。
// @author       Hermes Agent
// @match        https://linux.do/*
// @match        https://www.linux.do/*
// @updateURL    https://raw.githubusercontent.com/koala9527/linuxdo-ai-reply-userscript/main/linuxdo-ai-reply.user.js
// @downloadURL  https://raw.githubusercontent.com/koala9527/linuxdo-ai-reply-userscript/main/linuxdo-ai-reply.user.js
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // 防止脚本被重复注入（重复注入会出现两个悬浮按钮）
  if (window.__LDYA_LOADED__) return;
  window.__LDYA_LOADED__ = true;

  /* ==========================================================================
   * 1. 常量与默认配置
   * ========================================================================== */

  const APP = 'ldya';
  const VERSION = '1.0.0';

  const STORE_KEY_CONFIG = APP + ':config';
  const STORE_KEY_CACHE = APP + ':cache';

  const DEFAULT_CONFIG = {
    // 有一说一服务地址（本地默认 8011）
    apiBase: 'http://127.0.0.1:8011',
    // 语气：direct 直接 / calm 平和 / sharp 犀利
    tone: 'direct',
    // 进入帖子页后是否自动请求
    auto: true,
    // 发送给服务的内容上限（接口硬上限 2000）
    maxChars: 1900,
  };

  const TONE_OPTIONS = [
    { id: 'direct', label: '直接' },
    { id: 'calm', label: '平和' },
    { id: 'sharp', label: '犀利' },
  ];

  const REQUEST_TIMEOUT = 180000; // 单次生成通常 35-70 秒，留足余量
  const MIN_INPUT_LEN = 8;
  const MAX_INPUT_LEN = 2000;
  const CACHE_LIMIT = 30;
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const AUTO_COOLDOWN = 20000; // 同一帖子 20 秒内不重复自动请求
  const CONTENT_WAIT_TIMEOUT = 12000;

  /* ==========================================================================
   * 2. 配置与缓存存储
   * ========================================================================== */

  const store = {
    get(key, fallback) {
      try {
        const raw = typeof GM_getValue === 'function' ? GM_getValue(key, null) : null;
        if (raw === null || raw === undefined) return fallback;
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw);
          } catch (_) {
            return raw;
          }
        }
        return raw;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(value));
      } catch (_) {
        /* 存储失败不影响主流程 */
      }
    },
  };

  let config = Object.assign({}, DEFAULT_CONFIG, store.get(STORE_KEY_CONFIG, {}) || {});

  function saveConfig(patch) {
    config = Object.assign({}, config, patch || {});
    store.set(STORE_KEY_CONFIG, config);
  }

  function normalizeApiBase(value) {
    return String(value || '')
      .trim()
      .replace(/\/+$/, '');
  }

  function apiUrl(path) {
    return normalizeApiBase(config.apiBase) + path;
  }

  /* --------------------------------------------------------------------------
   * 结果缓存：同一帖子/同一页再次进入时直接复用，避免重复等 40 秒
   * ------------------------------------------------------------------------ */

  const cache = new Map();

  function loadCache() {
    const raw = store.get(STORE_KEY_CACHE, {}) || {};
    const now = Date.now();
    Object.keys(raw).forEach((key) => {
      const entry = raw[key];
      if (!entry || !entry.result) return;
      if (now - (entry.at || 0) > CACHE_TTL) return;
      cache.set(key, entry);
    });
  }

  function readCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - (entry.at || 0) > CACHE_TTL) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function writeCache(key, payload) {
    cache.set(key, payload);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    const plain = {};
    cache.forEach((value, k) => {
      plain[k] = value;
    });
    store.set(STORE_KEY_CACHE, plain);
  }

  /* ==========================================================================
   * 3. 通用工具
   * ========================================================================== */

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function debounce(fn, wait) {
    let timer = 0;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function formatDuration(ms) {
    const value = Number(ms) || 0;
    if (value < 1000) return value + 'ms';
    return (value / 1000).toFixed(1) + 's';
  }

  function formatClock(ts) {
    try {
      const d = new Date(ts);
      return (
        String(d.getHours()).padStart(2, '0') +
        ':' +
        String(d.getMinutes()).padStart(2, '0')
      );
    } catch (_) {
      return '';
    }
  }

  /* ==========================================================================
   * 4. 页面解析：只读当前帖子页 DOM，取标题与本页楼层内容
   * ========================================================================== */

  /**
   * 从路径解析帖子 id 与锚点楼层。
   * 支持 /t/slug/12345 、 /t/12345 、 /t/slug/12345/40 三种形态。
   */
  function parseTopicPath(pathname) {
    const path = String(pathname || '');
    const match = path.match(/^\/t\/(?:[^/]+\/)?(\d+)(?:\/(\d+))?/);
    if (!match) return null;
    return {
      topicId: match[1],
      floor: match[2] ? Number(match[2]) : null,
    };
  }

  function isTopicPage() {
    return !!parseTopicPath(location.pathname);
  }

  function cleanDocumentTitle(title) {
    return String(title || '')
      .replace(/\s*-\s*LINUX\s*DO\s*$/i, '')
      .replace(/\s+-\s+[^-]+$/, '')
      .trim();
  }

  /**
   * 取帖子标题。
   * 注意：滚动后 Discourse 会把 #topic-title 换成吸顶的 h1.header-title，
   * 所以这里按「正文标题 → 吸顶标题 → document.title」依次兜底。
   */
  function getTopicTitle() {
    const node =
      $('#topic-title h1') || $('.fancy-title') || $('h1.header-title') || $('.header-title') || null;
    let title = node ? String(node.textContent || '').trim() : '';
    if (!title) title = cleanDocumentTitle(document.title);
    return title;
  }

  /** 从帖子节点里抽出正文纯文本，剔除引用块、菜单和按钮等噪声。 */
  function extractPostText(article) {
    const cooked =
      article.querySelector('.post__regular .cooked') ||
      article.querySelector('.post__body .cooked') ||
      article.querySelector('.topic-body .cooked') ||
      article.querySelector('.cooked');
    if (!cooked) return '';

    const clone = cooked.cloneNode(true);

    // 引用块会重复上一楼内容，去掉以免污染输入
    $$('aside.quote, .quote, .cooked-selection-barrier, .post-menu-area, script, style, noscript', clone).forEach(
      (node) => node.remove()
    );

    // 图片统一折叠成占位符，避免大段 alt 文本
    $$('img', clone).forEach((img) => {
      img.replaceWith(document.createTextNode(' [图片] '));
    });

    // 换行还原：块级元素收尾补换行
    $$('br', clone).forEach((br) => br.replaceWith(document.createTextNode('\n')));
    $$('p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, div, tr', clone).forEach((el) => {
      el.appendChild(document.createTextNode('\n'));
    });

    return String(clone.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractPostAuthor(article) {
    const node =
      article.querySelector('.names .first.username a') ||
      article.querySelector('.names .username a') ||
      article.querySelector('.topic-meta-data .username') ||
      article.querySelector('[data-user-card]');
    if (!node) return '';
    const text = String(node.textContent || '').trim();
    if (text) return text;
    return String(node.getAttribute('data-user-card') || '').trim();
  }

  function extractPostFloor(article) {
    const link = article.querySelector('a.post-date') || article.querySelector('.post-date a');
    const href = link ? String(link.getAttribute('href') || '') : '';
    const match = href.match(/\/(\d+)\/?$/);
    if (match) return Number(match[1]);
    const id = article.getAttribute('data-post-id');
    return id ? Number(id) : null;
  }

  /** 采集当前页面上的帖子内容（标题 + 本页所有已渲染楼层）。 */
  function collectTopic() {
    const parsed = parseTopicPath(location.pathname);
    if (!parsed) return null;

    const title = getTopicTitle();

    const posts = $$('article[data-post-id]')
      .map((article) => {
        const text = extractPostText(article);
        if (!text) return null;
        const floor = extractPostFloor(article);
        const container = article.closest('.topic-post');
        const isOwner =
          floor === 1 || (container && container.classList.contains('topic-owner')) || false;
        return {
          author: extractPostAuthor(article) || '匿名',
          floor: floor,
          text: text,
          isOp: !!isOwner,
        };
      })
      .filter(Boolean);

    if (!title && !posts.length) return null;

    return {
      topicId: parsed.topicId,
      anchorFloor: parsed.floor,
      title: title,
      posts: posts,
      url: location.href,
      key: buildTopicKey(parsed),
    };
  }

  /**
   * 缓存/去重用的键：帖子 id + 页码锚点。
   * 只在路由变化时计算，滚动时 URL 变化不会触发重新请求。
   */
  function buildTopicKey(parsed) {
    const params = new URLSearchParams(location.search);
    const pageParam = params.get('page');
    const anchor = pageParam ? 'p' + pageParam : 'f' + (parsed.floor || 1);
    return parsed.topicId + '@' + anchor;
  }

  /* ==========================================================================
   * 5. 输入文本构造：标题 + 楼主 + 本页回复，裁剪到接口允许的长度
   * ========================================================================== */

  function buildInputText(topic) {
    const limit = clamp(Number(config.maxChars) || DEFAULT_CONFIG.maxChars, 200, MAX_INPUT_LEN);
    const lines = [];
    lines.push('帖子标题：' + (topic.title || '（无标题）'));

    const op = topic.posts.find((post) => post.isOp) || topic.posts[0] || null;
    const others = topic.posts.filter((post) => post !== op);

    if (op) {
      lines.push('');
      lines.push('【楼主】' + (op.text || ''));
    }

    let body = lines.join('\n');

    if (others.length) {
      const replyHeader = '\n\n【本页回复】\n';
      const replyLines = [];
      let used = body.length + replyHeader.length;

      for (const post of others) {
        const label = post.author + '：';
        const flat = post.text.replace(/\s*\n+\s*/g, ' ').trim();
        const room = limit - used - label.length - 1;
        if (room < 12) break;
        const text = flat.length > room ? flat.slice(0, room) + '…' : flat;
        const line = label + text;
        replyLines.push(line);
        used += line.length + 1;
      }

      if (replyLines.length) body += replyHeader + replyLines.join('\n');
    }

    // 仍然超长：优先裁剪楼主正文
    if (body.length > limit) {
      const keep = Math.max(60, limit - 20);
      body = body.slice(0, keep).replace(/\s+$/, '') + '\n（内容过长，已截断）';
    }

    return body.slice(0, MAX_INPUT_LEN).trim();
  }

  /* ==========================================================================
   * 6. 接口调用：POST /api/v1/say-one
   * ========================================================================== */

  function requestSayOne(text, tone) {
    return new Promise((resolve, reject) => {
      const url = apiUrl('/api/v1/say-one');
      const payload = JSON.stringify({ text: text, tone: tone || config.tone });

      const finish = (fn, value) => {
        try {
          fn(value);
        } catch (err) {
          console.error('[有一说一] 回调异常', err);
        }
      };

      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前脚本管理器不支持跨域请求，请使用 Tampermonkey / Violentmonkey'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: REQUEST_TIMEOUT,
        onload(response) {
          const raw = response.responseText || '';
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = null;
          }

          if (response.status >= 200 && response.status < 300 && data && data.reply) {
            finish(resolve, data);
            return;
          }

          if (response.status >= 200 && response.status < 300 && data && !data.reply) {
            finish(reject, new Error('服务没有返回回复内容'));
            return;
          }

          let message = '';
          if (data && typeof data.detail === 'string') message = data.detail;
          else if (data && data.detail && data.detail.message) message = data.detail.message;
          if (!message) {
            message =
              response.status === 0
                ? '连不上「有一说一」服务，请确认已启动且地址正确'
                : 'HTTP ' + response.status;
          }
          finish(reject, new Error(message));
        },
        onerror() {
          finish(reject, new Error('网络请求失败，请确认「有一说一」服务已启动'));
        },
        ontimeout() {
          finish(reject, new Error('请求超时（超过 ' + Math.round(REQUEST_TIMEOUT / 1000) + ' 秒）'));
        },
      });
    });
  }

  function checkHealth() {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        resolve({ ok: false, message: '脚本管理器不支持跨域请求' });
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: apiUrl('/api/health'),
        timeout: 8000,
        onload(response) {
          try {
            const data = JSON.parse(response.responseText || '{}');
            resolve({ ok: !!data.ok, data: data });
          } catch (_) {
            resolve({ ok: false, message: '服务返回内容无法解析' });
          }
        },
        onerror() {
          resolve({ ok: false, message: '连不上服务' });
        },
        ontimeout() {
          resolve({ ok: false, message: '服务响应超时' });
        },
      });
    });
  }

  /* ==========================================================================
   * 7. 运行状态
   * ========================================================================== */

  const state = {
    status: 'idle', // idle | loading | ready | error
    topicKey: '',
    topic: null,
    input: '',
    result: null,
    error: '',
    startedAt: 0,
    elapsed: 0,
    fromCache: false,
    panelOpen: false,
    settingsOpen: false,
    health: null,
  };

  let inflightKey = '';
  let elapsedTimer = 0;
  let lastAutoAt = 0;
  let lastAutoTopicId = '';

  function setStatus(status, patch) {
    state.status = status;
    if (patch) Object.assign(state, patch);
    renderFab();
    if (state.panelOpen) renderPanel();
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    state.startedAt = Date.now();
    elapsedTimer = setInterval(() => {
      state.elapsed = Date.now() - state.startedAt;
      renderFab();
      if (state.panelOpen) renderPanelStatus();
    }, 500);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = 0;
    }
  }

  /* ==========================================================================
   * 8. 样式
   * ========================================================================== */

  const CSS = `
  #${APP}-root {
    --ldya-bg: #ffffff;
    --ldya-fg: #1f2328;
    --ldya-sub: #667085;
    --ldya-line: #e6e8eb;
    --ldya-soft: #f5f6f8;
    --ldya-shadow: 0 16px 40px rgba(15, 23, 42, .16);
    --ldya-idle: #5b6472;
    --ldya-loading: #2563eb;
    --ldya-ready: #16a34a;
    --ldya-error: #dc2626;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
      "Microsoft YaHei", sans-serif;
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2147483000;
  }
  #${APP}-root[data-theme="dark"] {
    --ldya-bg: #1e2026;
    --ldya-fg: #e8eaed;
    --ldya-sub: #9aa3ae;
    --ldya-line: #33373f;
    --ldya-soft: #262a31;
    --ldya-shadow: 0 16px 40px rgba(0, 0, 0, .5);
  }
  #${APP}-root * { box-sizing: border-box; }

  .ldya-fab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 46px;
    padding: 0 18px 0 14px;
    border: 0;
    border-radius: 23px;
    background: var(--ldya-idle);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(15, 23, 42, .22);
    transition: background .25s ease, transform .18s ease, box-shadow .25s ease;
    -webkit-user-select: none;
    user-select: none;
  }
  .ldya-fab:hover { transform: translateY(-1px); box-shadow: 0 12px 28px rgba(15, 23, 42, .28); }
  .ldya-fab:active { transform: translateY(0); }
  .ldya-fab[data-status="loading"] { background: var(--ldya-loading); }
  .ldya-fab[data-status="ready"] { background: var(--ldya-ready); }
  .ldya-fab[data-status="error"] { background: var(--ldya-error); }

  .ldya-fab__icon {
    display: inline-flex;
    width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    flex: 0 0 20px;
  }
  .ldya-fab__icon svg { width: 20px; height: 20px; display: block; }

  .ldya-fab__spinner {
    width: 15px;
    height: 15px;
    border: 2px solid rgba(255, 255, 255, .35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: ldya-spin .8s linear infinite;
  }
  @keyframes ldya-spin { to { transform: rotate(360deg); } }

  .ldya-fab__badge {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #facc15;
    border: 2px solid #fff;
    display: none;
  }
  .ldya-fab[data-status="ready"] .ldya-fab__badge {
    display: block;
    animation: ldya-pulse 1.6s ease-out infinite;
  }
  @keyframes ldya-pulse {
    0% { box-shadow: 0 0 0 0 rgba(250, 204, 21, .75); }
    70% { box-shadow: 0 0 0 9px rgba(250, 204, 21, 0); }
    100% { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0); }
  }

  .ldya-panel {
    position: absolute;
    right: 0;
    bottom: 58px;
    width: min(430px, calc(100vw - 32px));
    max-height: min(72vh, 660px);
    display: flex;
    flex-direction: column;
    background: var(--ldya-bg);
    color: var(--ldya-fg);
    border: 1px solid var(--ldya-line);
    border-radius: 16px;
    box-shadow: var(--ldya-shadow);
    overflow: hidden;
    animation: ldya-in .18s ease-out;
  }
  @keyframes ldya-in {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to { opacity: 1; transform: none; }
  }

  .ldya-hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--ldya-line);
    background: var(--ldya-soft);
  }
  .ldya-hd__title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: .2px;
  }
  .ldya-hd__dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--ldya-idle);
  }
  .ldya-hd__dot[data-status="loading"] { background: var(--ldya-loading); }
  .ldya-hd__dot[data-status="ready"] { background: var(--ldya-ready); }
  .ldya-hd__dot[data-status="error"] { background: var(--ldya-error); }
  .ldya-hd__meta { font-size: 12px; font-weight: 500; color: var(--ldya-sub); }
  .ldya-hd__btns { display: flex; align-items: center; gap: 4px; }
  .ldya-icon-btn {
    width: 28px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: 8px;
    background: transparent; color: var(--ldya-sub);
    font-size: 15px; line-height: 1; cursor: pointer;
    transition: background .15s ease, color .15s ease;
  }
  .ldya-icon-btn:hover { background: rgba(120, 130, 145, .14); color: var(--ldya-fg); }

  .ldya-body {
    padding: 14px;
    overflow-y: auto;
    font-size: 13px;
    line-height: 1.65;
  }
  .ldya-body::-webkit-scrollbar { width: 8px; }
  .ldya-body::-webkit-scrollbar-thumb { background: rgba(120, 130, 145, .35); border-radius: 4px; }

  .ldya-loading { display: flex; align-items: center; gap: 10px; color: var(--ldya-sub); padding: 8px 0 4px; }
  .ldya-loading__bar {
    flex: 1; height: 3px; border-radius: 2px; overflow: hidden; background: var(--ldya-line); position: relative;
  }
  .ldya-loading__bar::after {
    content: ""; position: absolute; inset: 0; width: 40%;
    background: var(--ldya-loading); border-radius: 2px;
    animation: ldya-slide 1.4s ease-in-out infinite;
  }
  @keyframes ldya-slide { 0% { left: -40%; } 100% { left: 100%; } }

  .ldya-reply {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 14.5px;
    line-height: 1.72;
    color: var(--ldya-fg);
    padding: 12px 13px;
    border-radius: 12px;
    background: var(--ldya-soft);
    border: 1px solid var(--ldya-line);
    -webkit-user-select: text;
    user-select: text;
  }

  .ldya-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .ldya-btn {
    display: inline-flex; align-items: center; gap: 6px;
    height: 34px; padding: 0 14px;
    border-radius: 9px; border: 1px solid var(--ldya-line);
    background: var(--ldya-bg); color: var(--ldya-fg);
    font-size: 13px; font-weight: 600; cursor: pointer;
    transition: background .15s ease, border-color .15s ease, transform .12s ease;
  }
  .ldya-btn:hover { background: var(--ldya-soft); }
  .ldya-btn:active { transform: scale(.985); }
  .ldya-btn--primary { background: var(--ldya-ready); border-color: var(--ldya-ready); color: #fff; }
  .ldya-btn--primary:hover { background: #15803d; border-color: #15803d; }
  .ldya-btn:disabled { opacity: .5; cursor: not-allowed; }

  .ldya-points { margin-top: 14px; display: grid; gap: 8px; }
  .ldya-point { display: flex; gap: 8px; align-items: flex-start; }
  .ldya-point__k {
    flex: 0 0 auto; min-width: 44px;
    font-size: 12px; font-weight: 700; color: var(--ldya-sub);
    padding-top: 1px;
  }
  .ldya-point__v { flex: 1; color: var(--ldya-fg); font-size: 12.5px; }
  .ldya-tag {
    display: inline-flex; align-items: center; height: 20px; padding: 0 8px;
    border-radius: 10px; font-size: 11px; font-weight: 700;
    background: var(--ldya-soft); color: var(--ldya-sub); border: 1px solid var(--ldya-line);
  }
  .ldya-tag--high { background: rgba(22, 163, 74, .12); color: #15803d; border-color: rgba(22, 163, 74, .3); }
  .ldya-tag--medium { background: rgba(37, 99, 235, .12); color: #1d4ed8; border-color: rgba(37, 99, 235, .3); }
  .ldya-tag--low { background: rgba(148, 163, 184, .18); color: #475569; border-color: rgba(148, 163, 184, .35); }

  .ldya-more { margin-top: 12px; border-top: 1px solid var(--ldya-line); padding-top: 10px; }
  .ldya-more > summary {
    cursor: pointer; font-size: 12px; font-weight: 600; color: var(--ldya-sub);
    list-style: none; outline: none; display: flex; align-items: center; gap: 6px;
  }
  .ldya-more > summary::-webkit-details-marker { display: none; }
  .ldya-more > summary::before { content: "›"; font-size: 14px; transition: transform .15s ease; }
  .ldya-more[open] > summary::before { transform: rotate(90deg); }
  .ldya-more > summary:hover { color: var(--ldya-fg); }
  .ldya-pre {
    margin: 8px 0 0;
    padding: 10px 11px;
    border-radius: 10px;
    background: var(--ldya-soft);
    border: 1px solid var(--ldya-line);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 220px;
    overflow: auto;
    color: var(--ldya-fg);
  }
  .ldya-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin-top: 8px; font-size: 12px; }
  .ldya-kv dt { color: var(--ldya-sub); }
  .ldya-kv dd { margin: 0; color: var(--ldya-fg); }

  .ldya-error {
    padding: 12px;
    border-radius: 10px;
    background: rgba(220, 38, 38, .08);
    border: 1px solid rgba(220, 38, 38, .25);
    color: #b91c1c;
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
  }
  #${APP}-root[data-theme="dark"] .ldya-error { color: #fca5a5; }

  .ldya-empty { color: var(--ldya-sub); font-size: 13px; padding: 6px 0; }

  .ldya-settings { margin-top: 12px; }
  .ldya-field { margin-top: 10px; }
  .ldya-field > label {
    display: block; font-size: 12px; font-weight: 600; color: var(--ldya-sub); margin-bottom: 5px;
  }
  .ldya-input, .ldya-select {
    width: 100%; height: 34px; padding: 0 10px;
    border-radius: 9px; border: 1px solid var(--ldya-line);
    background: var(--ldya-bg); color: var(--ldya-fg);
    font-size: 12.5px; outline: none;
    transition: border-color .15s ease;
  }
  .ldya-input:focus, .ldya-select:focus { border-color: var(--ldya-loading); }
  .ldya-inline { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ldya-fg); }
  .ldya-inline input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--ldya-ready); }
  .ldya-hint { margin-top: 8px; font-size: 11.5px; color: var(--ldya-sub); line-height: 1.6; }
  .ldya-toast {
    position: absolute; left: 50%; bottom: 68px; transform: translateX(-50%);
    padding: 7px 14px; border-radius: 18px;
    background: rgba(17, 24, 39, .92); color: #fff; font-size: 12.5px; font-weight: 500;
    pointer-events: none; opacity: 0; transition: opacity .2s ease;
    white-space: nowrap; z-index: 5;
  }
  .ldya-toast[data-show="1"] { opacity: 1; }
  `;

  function injectStyle() {
    if (document.getElementById(APP + '-style')) return;
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(CSS);
      return;
    }
    const style = document.createElement('style');
    style.id = APP + '-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /* ==========================================================================
   * 9. UI 渲染
   * ========================================================================== */

  let root = null;
  let fab = null;
  let panel = null;
  let toastEl = null;
  let toastTimer = 0;

  function parseRgb(value) {
    const match = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map((item) => parseFloat(item));
    if (parts.length < 3) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function detectTheme() {
    const candidates = [document.body, $('#main-outlet'), $('.d-header'), document.documentElement];
    for (const el of candidates) {
      if (!el) continue;
      const rgb = parseRgb(getComputedStyle(el).backgroundColor);
      if (!rgb || rgb.a < 0.2) continue;
      const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
      return luminance > 0.55 ? 'light' : 'dark';
    }
    if (document.documentElement.classList.contains('dark') || document.body.classList.contains('dark')) {
      return 'dark';
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function ensureRoot() {
    if (root && document.body.contains(root)) return root;
    injectStyle();
    root = document.createElement('div');
    root.id = APP + '-root';
    root.setAttribute('data-theme', detectTheme());

    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'ldya-fab';
    fab.innerHTML =
      '<span class="ldya-fab__icon"></span><span class="ldya-fab__text">有一说一</span><span class="ldya-fab__badge"></span>';
    fab.addEventListener('click', () => togglePanel());

    toastEl = document.createElement('div');
    toastEl.className = 'ldya-toast';

    root.appendChild(fab);
    root.appendChild(toastEl);
    document.body.appendChild(root);
    renderFab();
    return root;
  }

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.setAttribute('data-show', '1');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.setAttribute('data-show', '0'), 1800);
  }

  const ICONS = {
    idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 8.6 7.9z"/></svg>',
    loading:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 8.6 7.9z"/></svg>',
    ready:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  };

  function fabText() {
    if (state.status === 'loading') {
      const seconds = Math.max(0, Math.round(state.elapsed / 1000));
      return '生成中 ' + seconds + 's';
    }
    if (state.status === 'ready') return '看回复';
    if (state.status === 'error') return '生成失败';
    return '有一说一';
  }

  function renderFab() {
    if (!fab) return;
    fab.setAttribute('data-status', state.status);
    const icon = fab.querySelector('.ldya-fab__icon');
    const text = fab.querySelector('.ldya-fab__text');
    if (icon) {
      icon.innerHTML =
        state.status === 'loading' ? '<span class="ldya-fab__spinner"></span>' : ICONS[state.status] || ICONS.idle;
    }
    if (text) text.textContent = fabText();
    fab.title = state.status === 'ready' ? '回复已生成，点击查看' : '有一说一 · 为当前页生成回复';
  }

  function togglePanel(force) {
    const open = typeof force === 'boolean' ? force : !state.panelOpen;
    state.panelOpen = open;
    if (open) {
      ensureRoot();
      if (!panel || !root.contains(panel)) {
        panel = document.createElement('div');
        panel.className = 'ldya-panel';
        root.appendChild(panel);
      }
      panel.style.display = 'flex';
      renderPanel();
      if (state.status === 'idle' && config.auto === false) {
        // 手动模式下打开面板时，若已有内容则直接开始生成
        maybeAutoGenerate({ manual: true });
      }
    } else if (panel) {
      panel.style.display = 'none';
    }
  }

  function confidenceTag(confidence) {
    const map = {
      high: { label: '高置信', cls: 'ldya-tag--high' },
      medium: { label: '中置信', cls: 'ldya-tag--medium' },
      low: { label: '低置信', cls: 'ldya-tag--low' },
    };
    const item = map[confidence] || { label: '未知', cls: '' };
    return '<span class="ldya-tag ' + item.cls + '">' + escapeHtml(item.label) + '</span>';
  }

  function toneLabel(tone) {
    const found = TONE_OPTIONS.find((item) => item.id === tone);
    return found ? found.label : tone;
  }

  function renderPanelStatus() {
    if (!panel) return;
    const meta = panel.querySelector('.ldya-hd__meta');
    const dot = panel.querySelector('.ldya-hd__dot');
    if (dot) dot.setAttribute('data-status', state.status);
    if (!meta) return;
    if (state.status === 'loading') {
      meta.textContent = '生成中 ' + Math.max(0, Math.round(state.elapsed / 1000)) + 's';
    } else if (state.status === 'ready') {
      meta.textContent = (state.fromCache ? '缓存 · ' : '') + formatClock((state.result && state.result.__at) || Date.now());
    } else if (state.status === 'error') {
      meta.textContent = '失败';
    } else {
      meta.textContent = '';
    }
  }

  function renderPanel() {
    if (!panel) return;
    const settingsOpen = state.settingsOpen;
    const detailsState = {
      input: panel.querySelector('.ldya-more--input')?.open || false,
      process: panel.querySelector('.ldya-more--process')?.open || false,
    };

    let bodyHtml = '';

    if (state.status === 'loading') {
      bodyHtml =
        '<div class="ldya-loading"><span>正在生成回复</span><span class="ldya-loading__bar"></span></div>' +
        '<div class="ldya-empty" style="margin-top:10px">已把本页标题与内容交给「有一说一」，通常需要 35–70 秒。</div>';
    } else if (state.status === 'error') {
      bodyHtml =
        '<div class="ldya-error">' +
        escapeHtml(state.error || '生成失败') +
        '</div>' +
        '<div class="ldya-row">' +
        '<button class="ldya-btn ldya-btn--primary" data-act="regen">重试</button>' +
        '<button class="ldya-btn" data-act="settings">检查设置</button>' +
        '</div>';
    } else if (state.status === 'ready' && state.result) {
      const result = state.result;
      const reply = String(result.reply || '').trim();
      const points = [];
      if (result.key_point) points.push(['判断', result.key_point]);
      if (result.global_pattern) points.push(['共同看法', result.global_pattern]);
      if (result.caveat) points.push(['说明', result.caveat]);

      bodyHtml =
        '<div class="ldya-reply" id="' +
        APP +
        '-reply-text">' +
        escapeHtml(reply || '（服务没有返回回复正文）') +
        '</div>' +
        '<div class="ldya-row">' +
        '<button class="ldya-btn ldya-btn--primary" data-act="copy">复制回复</button>' +
        '<button class="ldya-btn" data-act="regen">重新生成</button>' +
        '</div>' +
        (points.length
          ? '<div class="ldya-points">' +
            points
              .map(
                (item) =>
                  '<div class="ldya-point"><span class="ldya-point__k">' +
                  escapeHtml(item[0]) +
                  '</span><span class="ldya-point__v">' +
                  escapeHtml(item[1]) +
                  '</span></div>'
              )
              .join('') +
            '</div>'
          : '') +
        '<details class="ldya-more ldya-more--process"><summary>过程与依据</summary>' +
        '<dl class="ldya-kv">' +
        '<dt>置信度</dt><dd>' +
        confidenceTag(result.confidence) +
        '</dd>' +
        '<dt>检索规模</dt><dd>' +
        escapeHtml(
          result.process
            ? (result.process.corpus_topics || 0).toLocaleString('zh-CN') +
                ' 条帖子 · 召回 ' +
                (result.process.unique_candidates || 0) +
                ' · 引用 ' +
                (result.process.cited_evidence_count || 0)
            : '未知'
        ) +
        '</dd>' +
        '<dt>耗时</dt><dd>' +
        escapeHtml(
          result.process && result.process.timings_ms ? formatDuration(result.process.timings_ms['总计']) : '-'
        ) +
        '</dd>' +
        '<dt>语气</dt><dd>' +
        escapeHtml(toneLabel(config.tone)) +
        '</dd>' +
        '</dl>' +
        (result.evidence && result.evidence.length
          ? '<div class="ldya-hint">参考的相似讨论：' +
            escapeHtml(
              result.evidence
                .slice(0, 3)
                .map((item) => (item.topic_hint || '').slice(0, 40))
                .filter(Boolean)
                .join(' / ')
            ) +
            '</div>'
          : '') +
        '</details>' +
        '<details class="ldya-more ldya-more--input"><summary>输入预览（发给服务的内容）</summary>' +
        '<pre class="ldya-pre">' +
        escapeHtml(state.input) +
        '</pre></details>';
    } else {
      bodyHtml =
        '<div class="ldya-empty">' +
        (isTopicPage() ? '还没有生成回复。' : '当前不在帖子详情页，打开任意帖子会自动生成。') +
        '</div>' +
        (isTopicPage()
          ? '<div class="ldya-row"><button class="ldya-btn ldya-btn--primary" data-act="regen">生成回复</button></div>'
          : '');
    }

    // 设置区
    bodyHtml +=
      '<details class="ldya-more ldya-settings"' +
      (settingsOpen ? ' open' : '') +
      '><summary>设置</summary>' +
      '<div class="ldya-field"><label>服务地址</label>' +
      '<input class="ldya-input" data-field="apiBase" value="' +
      escapeHtml(config.apiBase) +
      '" placeholder="http://127.0.0.1:8011" /></div>' +
      '<div class="ldya-field"><label>语气</label>' +
      '<select class="ldya-select" data-field="tone">' +
      TONE_OPTIONS.map(
        (item) =>
          '<option value="' +
          item.id +
          '"' +
          (config.tone === item.id ? ' selected' : '') +
          '>' +
          item.label +
          '</option>'
      ).join('') +
      '</select></div>' +
      '<div class="ldya-field"><label class="ldya-inline"><input type="checkbox" data-field="auto"' +
      (config.auto ? ' checked' : '') +
      ' /> 进入帖子页自动生成</label></div>' +
      '<div class="ldya-field"><label>发送内容上限（字符）</label>' +
      '<input class="ldya-input" data-field="maxChars" type="number" min="200" max="2000" step="100" value="' +
      escapeHtml(config.maxChars) +
      '" /></div>' +
      '<div class="ldya-hint">修改后立即生效，服务地址变更会清空本次结果缓存。</div>' +
      '</details>';

    panel.innerHTML =
      '<div class="ldya-hd">' +
      '<div class="ldya-hd__title"><span class="ldya-hd__dot" data-status="' +
      state.status +
      '"></span>有一说一' +
      '<span class="ldya-hd__meta"></span></div>' +
      '<div class="ldya-hd__btns">' +
      '<button class="ldya-icon-btn" data-act="refresh" title="重新检测页面">⟳</button>' +
      '<button class="ldya-icon-btn" data-act="close" title="关闭">✕</button>' +
      '</div>' +
      '</div>' +
      '<div class="ldya-body">' +
      bodyHtml +
      '</div>';

    if (detailsState.input) {
      const el = panel.querySelector('.ldya-more--input');
      if (el) el.open = true;
    }
    if (detailsState.process) {
      const el = panel.querySelector('.ldya-more--process');
      if (el) el.open = true;
    }

    renderPanelStatus();
    bindPanelEvents();
  }

  function bindPanelEvents() {
    if (!panel || panel.__bound) return;
    panel.__bound = true;

    panel.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-act]');
      if (!trigger) return;
      const act = trigger.getAttribute('data-act');

      if (act === 'close') {
        togglePanel(false);
        return;
      }
      if (act === 'copy') {
        const text = String((state.result && state.result.reply) || '').trim();
        if (!text) return;
        copyText(text).then((ok) => showToast(ok ? '已复制回复' : '复制失败，请手动选择文本'));
        return;
      }
      if (act === 'regen') {
        runGenerate({ manual: true });
        return;
      }
      if (act === 'refresh') {
        runGenerate({ manual: true, force: true });
        return;
      }
      if (act === 'settings') {
        state.settingsOpen = true;
        renderPanel();
        return;
      }
    });

    // 设置区开合状态记忆
    panel.addEventListener('toggle', (event) => {
      const target = event.target;
      if (target && target.classList && target.classList.contains('ldya-settings')) {
        state.settingsOpen = !!target.open;
      }
    }, true);

    panel.addEventListener('change', (event) => {
      const field = event.target.getAttribute && event.target.getAttribute('data-field');
      if (!field) return;
      if (field === 'auto') {
        saveConfig({ auto: !!event.target.checked });
        return;
      }
      if (field === 'tone') {
        saveConfig({ tone: event.target.value });
        if (state.status === 'ready') showToast('语气已切换，重新生成后生效');
        return;
      }
      if (field === 'maxChars') {
        const value = clamp(Number(event.target.value) || DEFAULT_CONFIG.maxChars, 200, MAX_INPUT_LEN);
        saveConfig({ maxChars: value });
        event.target.value = String(value);
        return;
      }
      if (field === 'apiBase') {
        const value = normalizeApiBase(event.target.value) || DEFAULT_CONFIG.apiBase;
        saveConfig({ apiBase: value });
        event.target.value = value;
        cache.clear();
        store.set(STORE_KEY_CACHE, {});
        state.health = null;
        showToast('服务地址已更新');
      }
    });
  }

  async function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        return true;
      }
    } catch (_) {
      /* 继续尝试其他方式 */
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      /* 继续降级 */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function hideAll() {
    if (root) root.style.display = 'none';
  }

  function showAll() {
    if (root) root.style.display = '';
  }

  /* ==========================================================================
   * 10. 生成流程
   * ========================================================================== */

  function waitForContent(timeout) {
    const limit = timeout || CONTENT_WAIT_TIMEOUT;
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        // 标题可能被吸顶栏替换，这里只等楼层渲染出来即可
        const hasPost = $$('article[data-post-id]').length > 0;
        if (hasPost) {
          resolve(true);
          return;
        }
        if (Date.now() - started > limit) {
          resolve(false);
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  async function runGenerate(options) {
    const opts = options || {};
    if (inflightKey && !opts.force) {
      // 同一帖子/同一页正在生成时才拦截；换帖可以直接开始新的
      const nextKey = currentRouteSignature();
      if (nextKey === inflightKey) {
        showToast('正在生成中，请稍候');
        return;
      }
    }

    const topic = collectTopic();
    if (!topic) {
      setStatus('idle', { error: '', result: null });
      return;
    }

    const input = buildInputText(topic);
    if (input.length < MIN_INPUT_LEN) {
      setStatus('error', { error: '当前页面可读内容太少，无法生成回复。', topic: topic, input: input });
      return;
    }

    const key = topic.key;
    state.topic = topic;
    state.input = input;
    state.topicKey = key;
    state.fromCache = false;
    state.error = '';
    inflightKey = key;
    lastAutoAt = Date.now();
    lastAutoTopicId = topic.topicId;

    setStatus('loading', { result: null, elapsed: 0 });
    startElapsedTimer();

    try {
      const result = await requestSayOne(input, config.tone);
      if (inflightKey !== key) return;
      const stamped = Object.assign({}, result, { __at: Date.now(), __input: input });
      state.result = stamped;
      state.elapsed = Date.now() - state.startedAt;
      writeCache(key, { at: Date.now(), result: stamped, input: input, topicId: topic.topicId, title: topic.title });
      stopElapsedTimer();
      setStatus('ready', { fromCache: false });
      if (state.panelOpen) renderPanel();
    } catch (err) {
      if (inflightKey !== key) return;
      stopElapsedTimer();
      setStatus('error', { error: (err && err.message) || '生成失败', result: null });
    } finally {
      if (inflightKey === key) inflightKey = '';
      renderFab();
    }
  }

  async function maybeAutoGenerate(options) {
    const opts = options || {};
    if (!isTopicPage()) return;
    if (!config.auto && !opts.manual) return;

    const parsed = parseTopicPath(location.pathname);
    if (!parsed) return;

    const key = buildTopicKey(parsed);
    if (inflightKey && inflightKey === key) return;

    // 冷却：同一帖子短时间内不重复自动请求
    if (!opts.manual && lastAutoTopicId === parsed.topicId && Date.now() - lastAutoAt < AUTO_COOLDOWN) {
      return;
    }

    const cached = readCache(key);
    if (cached && !opts.force) {
      state.topicKey = key;
      state.input = cached.input || '';
      state.result = cached.result;
      state.elapsed = 0;
      setStatus('ready', { fromCache: true });
      return;
    }

    const ready = await waitForContent(CONTENT_WAIT_TIMEOUT);
    if (!ready) {
      setStatus('error', { error: '没有读到帖子内容，请刷新页面后重试。' });
      return;
    }

    runGenerate({ manual: opts.manual });
  }

  /* ==========================================================================
   * 11. 路由监听：Discourse 是 SPA，需要拦截 pushState / popstate
   * ========================================================================== */

  let lastHref = location.href;
  let lastRouteId = '';

  function currentRouteSignature() {
    if (!isTopicPage()) return 'none';
    const parsed = parseTopicPath(location.pathname);
    return buildTopicKey(parsed);
  }

  /**
   * 「是否需要重新生成」的判定依据：帖子 id + page 参数。
   * Discourse 在帖子内跳锚点（点楼层、滚动）只会改末尾楼层号，
   * 这时不应该重新花几十秒再生成一次。
   */
  function currentRouteId() {
    if (!isTopicPage()) return 'none';
    const parsed = parseTopicPath(location.pathname);
    const page = new URLSearchParams(location.search).get('page') || '';
    return parsed.topicId + '|' + page;
  }

  function handleRouteChange(source) {
    if (location.href === lastHref && source !== 'force') return;
    lastHref = location.href;

    const routeId = currentRouteId();
    if (routeId === lastRouteId) {
      // 同一帖子同一页，只是锚点变化，保留已有结果
      return;
    }
    lastRouteId = routeId;

    const signature = currentRouteSignature();

    if (!isTopicPage()) {
      hideAll();
      state.status = 'idle';
      state.result = null;
      state.error = '';
      stopElapsedTimer();
      togglePanel(false);
      return;
    }

    showAll();
    ensureRoot();
    root.setAttribute('data-theme', detectTheme());

    const cached = readCache(signature);
    if (cached) {
      state.topicKey = signature;
      state.input = cached.input || '';
      state.result = cached.result;
      state.elapsed = 0;
      setStatus('ready', { fromCache: true });
      return;
    }

    setStatus('idle', { result: null, error: '', elapsed: 0, input: '' });
    maybeAutoGenerate();
  }

  function installRouter() {
    const wrap = (name) => {
      const original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function patched() {
        const ret = original.apply(this, arguments);
        setTimeout(() => handleRouteChange(name), 0);
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');

    window.addEventListener('popstate', () => setTimeout(() => handleRouteChange('popstate'), 0));

    // 兜底：轮询 URL，覆盖个别不经过 history 的跳转
    setInterval(() => {
      if (location.href !== lastHref) handleRouteChange('poll');
    }, 800);

    // Ember 渲染完成但 URL 未变时（例如从骨架屏变成真实楼层），补一次检测
    const debouncedCheck = debounce(() => {
      if (!isTopicPage()) return;
      if (state.status !== 'idle') return;
      if (inflightKey) return;
      if (!config.auto) return;
      if ($$('article[data-post-id]').length === 0) return;
      maybeAutoGenerate();
    }, 1500);

    const observer = new MutationObserver(() => {
      if (!isTopicPage()) return;
      if (state.status !== 'idle') return;
      debouncedCheck();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ==========================================================================
   * 12. 启动
   * ========================================================================== */

  function boot() {
    loadCache();
    ensureRoot();

    if (!isTopicPage()) {
      hideAll();
      installRouter();
      return;
    }

    showAll();
    handleRouteChange('force');
    installRouter();

    // 首次进入做一次健康检查，失败时把原因写进面板
    checkHealth().then((result) => {
      state.health = result;
      if (!result.ok && state.status === 'idle') {
        setStatus('error', {
          error:
            '连不上「有一说一」服务（' +
            normalizeApiBase(config.apiBase) +
            '）。\n请确认服务已启动：在 reply-assistant 目录运行 python run_one.py。',
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 便于调试
  window.__LDYA__ = {
    version: VERSION,
    state: state,
    config: () => config,
    collect: collectTopic,
    buildInput: () => (collectTopic() ? buildInputText(collectTopic()) : ''),
    generate: () => runGenerate({ manual: true, force: true }),
    open: () => togglePanel(true),
  };
})();
