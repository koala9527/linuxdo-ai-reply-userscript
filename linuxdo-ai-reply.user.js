// ==UserScript==
// @name         Linux.do 有一说一 · 回帖助手
// @namespace    https://github.com/koala9527/linuxdo-ai-reply-userscript
// @version      1.3.3
// @description  本地回帖文案助手与可调速浏览辅助；浏览速度 0–100，默认 10%，遇到限流、验证或页面隐藏即暂停，不保证账号安全或阅读数据增长。
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

  // 防止脚本被重复注入
  if (window.__LDYA_LOADED__) return;
  window.__LDYA_LOADED__ = true;

  /* ==========================================================================
   * 1. 常量与默认配置
   * ========================================================================== */

  const APP = 'ldya';
  const VERSION = '1.3.3';

  const STORE_KEY_CONFIG = APP + ':config';
  const STORE_KEY_CACHE = APP + ':cache';
  const STORE_KEY_BROWSE_CONFIG = APP + ':browse:config';
  const STORE_KEY_BROWSE_STATE = APP + ':browse:state';
  const STORE_KEY_BROWSE_HISTORY = APP + ':browse:history';
  const STORE_KEY_ACTIVE_TAB = APP + ':ui:tab';

  // 有一说一回复助手默认配置
  const DEFAULT_CONFIG = {
    apiBase: 'http://127.0.0.1:8011',
    tone: 'direct',
    auto: true,
    maxChars: 1900,
  };

  // 10% 是基础操作速度（1×），100% 是十倍速度（10×）；0% 暂停。
  const DEFAULT_BROWSE_CONFIG = {
    speedPercent: 10,          // 0=暂停，10=基础速度，100=十倍速度
    targetTopics: 12,          // 目标浏览话题数
    targetPosts: 45,           // 目标浏览帖子数
    maxPostsPerTopic: 6,       // 每个话题内细读楼层数 (3-12)
    minPostDwellSeconds: 6,    // 单楼最少细读时间 (秒)
    maxPostDwellSeconds: 15,   // 单楼最多细读时间 (秒)
    charsPerSecond: 20,        // 字符/秒加权（长楼层自动增加阅读时间）
    cooldownSeconds: 18,       // 话题切换冷却等待 (秒，建议 15-30)
    fatigueInterval: 5,        // 每浏览 N 个话题后触发一次疲劳休整
    fatigueRestSeconds: 90,    // 疲劳休整等待时间 (秒)
    autoResume: true,          // 仅在启动任务的同一标签页内跨页面继续
  };

  const TONE_OPTIONS = [
    { id: 'direct', label: '直接' },
    { id: 'calm', label: '平和' },
    { id: 'sharp', label: '犀利' },
  ];

  const REQUEST_TIMEOUT = 180000;
  const MIN_INPUT_LEN = 8;
  const MAX_INPUT_LEN = 2000;
  const CACHE_LIMIT = 30;
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const AUTO_COOLDOWN = 20000;
  const CONTENT_WAIT_TIMEOUT = 12000;

  /* ==========================================================================
   * 2. 配置与缓存存储
   * ========================================================================== */

  const store = {
    get(key, fallback) {
      try {
        const raw = typeof GM_getValue === 'function' ? GM_getValue(key, null) : null;
        if (raw === null || raw === undefined) {
          const local = localStorage.getItem(key);
          if (local !== null && local !== undefined) {
            try { return JSON.parse(local); } catch (_) { return local; }
          }
          return fallback;
        }
        if (typeof raw === 'string') {
          try { return JSON.parse(raw); } catch (_) { return raw; }
        }
        return raw;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(value));
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
      } catch (_) {}
    },
  };

  let config = Object.assign({}, DEFAULT_CONFIG, store.get(STORE_KEY_CONFIG, {}) || {});
  function normalizeBrowseSpeed(value) {
    if (value === null || value === undefined || String(value).trim() === '') return 10;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 10;
  }

  function normalizeBrowseConfig(value) {
    const result = Object.assign({}, DEFAULT_BROWSE_CONFIG);
    const input = value && typeof value === 'object' ? value : {};
    const ranges = {
      targetTopics: [1, 100], targetPosts: [1, 300], maxPostsPerTopic: [1, 25],
      minPostDwellSeconds: [6, 120], maxPostDwellSeconds: [6, 120],
      charsPerSecond: [10, 100], cooldownSeconds: [18, 600],
      fatigueInterval: [1, 20], fatigueRestSeconds: [90, 1800],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const number = Number(input[key]);
      if (input[key] !== null && input[key] !== '' && Number.isFinite(number)) {
        result[key] = Math.min(max, Math.max(min, Math.round(number)));
      }
    }
    result.maxPostDwellSeconds = Math.max(result.minPostDwellSeconds, result.maxPostDwellSeconds);
    result.speedPercent = normalizeBrowseSpeed(input.speedPercent);
    result.autoResume = input.autoResume !== false;
    return result;
  }

  let browseConfig = normalizeBrowseConfig(store.get(STORE_KEY_BROWSE_CONFIG, {}));

  function saveConfig(patch) {
    config = Object.assign({}, config, patch || {});
    store.set(STORE_KEY_CONFIG, config);
  }

  function saveBrowseConfig(patch) {
    browseConfig = normalizeBrowseConfig(Object.assign({}, browseConfig, patch || {}));
    store.set(STORE_KEY_BROWSE_CONFIG, browseConfig);
    if (browseState.running && browseConfig.speedPercent === 0 && !browseState.paused) {
      autoBrowse.suspend('speed', '速度为 0%，浏览已暂停');
    } else if (browseState.running && browseState.pauseReason === 'speed' && browseConfig.speedPercent > 0) {
      browseState.paused = false;
      browseState.pauseReason = '';
      browseState.status = 'reading';
      persistBrowseState();
      autoBrowse.step();
    }
    renderHud();
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

  function randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

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
   * 7. 运行状态与 Tab 切换
   * ========================================================================== */

  const state = {
    status: 'idle', // idle | loading | ready | error
    activeTab: store.get(STORE_KEY_ACTIVE_TAB, 'reply'), // 'reply' | 'browse' | 'monitor'
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
      if (state.panelOpen && state.activeTab === 'reply') renderPanelStatus();
    }, 500);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = 0;
    }
  }

  /* ==========================================================================
   * 8. 前端风控与监控探测模块 (Risk & Telemetry Detector)
   * ========================================================================== */

  const riskDetector = {
    data: {
      timingRequests: [],
      lastTiming: null,
      timingsSuccessCount: 0,
      timingsErrorCount: 0,
      cfDetected: false,
      trackersDetected: [],
      visibilityChanges: 0,
      lastVisibilityState: 'visible',
      hiddenSince: 0,
    },

    init() {
      this.data.lastVisibilityState = document.visibilityState;
      document.addEventListener('visibilitychange', () => {
        this.data.lastVisibilityState = document.visibilityState;
        this.data.visibilityChanges++;
        if (document.hidden) {
          this.data.hiddenSince = Date.now();
          autoBrowse.suspend('hidden', '页面已隐藏，浏览已暂停；返回后请手动恢复');
        } else {
          this.data.hiddenSince = 0;
        }
        renderHud();
        if (state.panelOpen && state.activeTab === 'monitor') renderPanel();
      });

      this.hookNetwork();
      this.scanPage();
    },

    hookNetwork() {
      try {
        const origFetch = window.fetch;
        if (typeof origFetch === 'function') {
          window.fetch = function (resource, init) {
            const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
            const isTiming = typeof url === 'string' && url.includes('/topics/timings');
            const startTime = Date.now();
            const promise = origFetch.apply(this, arguments);
            if (isTiming) {
              promise
                .then((res) => {
                  riskDetector.recordTiming(res.status, Date.now() - startTime);
                })
                .catch(() => {
                  riskDetector.recordTiming(0, Date.now() - startTime);
                });
            }
            return promise;
          };
        }

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__ldya_isTiming = typeof url === 'string' && url.includes('/topics/timings');
          this.__ldya_startTime = Date.now();
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          if (this.__ldya_isTiming) {
            this.addEventListener('loadend', () => {
              riskDetector.recordTiming(this.status, Date.now() - (this.__ldya_startTime || Date.now()));
            });
          }
          return origSend.apply(this, arguments);
        };
      } catch (err) {
        console.warn('[有一说一] 网络监控挂钩提示:', err);
      }
    },

    recordTiming(status, duration) {
      const entry = {
        time: Date.now(),
        status: status,
        duration: duration,
      };
      this.data.lastTiming = entry;
      this.data.timingRequests.unshift(entry);
      if (this.data.timingRequests.length > 20) this.data.timingRequests.pop();
      if (status >= 200 && status < 300) {
        this.data.timingsSuccessCount++;
      } else {
        this.data.timingsErrorCount++;
      }
      if (status === 429 || status === 403) {
        autoBrowse.suspend('limit', `收到 HTTP ${status}，浏览已暂停；请检查网站提示后手动恢复`);
      }
      if (state.panelOpen && state.activeTab === 'monitor') renderPanel();
    },

    scanPage() {
      const hasCfDom = Array.from(document.querySelectorAll(
        '.cf-turnstile, #challenge-stage, #cf-wrapper, iframe[src*="challenges.cloudflare.com"]'
      )).some((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (typeof element.checkVisibility === 'function') {
          return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        for (let node = element; node; node = node.parentElement) {
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        }
        return true;
      });
      this.data.cfDetected = hasCfDom;

      const trackers = [];
      if (window.Sentry || window.__SENTRY__) trackers.push('Sentry 异常监控');
      if (window.dataLayer || window.gtag) trackers.push('Google Analytics');
      if (document.querySelector('script[src*="cloudflareinsights"], script[src*="cdn-cgi/rum"]')) {
        trackers.push('Cloudflare Web Analytics');
      }
      if (window.umami) trackers.push('Umami');
      this.data.trackersDetected = trackers;
    },

    getReport() {
      this.scanPage();
      const isHidden = document.hidden;
      const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      const recentTiming = this.data.lastTiming;
      const timingOk = !recentTiming || (recentTiming.status >= 200 && recentTiming.status < 300);

      let safetyLevel = '未知';
      let safetySummary = '仅观察页面信号，无法判断账号风险或后台规则';
      const issues = [];

      if (isHidden) {
        safetyLevel = 'B';
        safetySummary = '阅读计时已暂停（页面处于后台）';
        issues.push(
          '当前标签页处于后台/隐藏状态。Discourse 的 screen-track.js 在页面不可见时会自动停止累计阅读时间。建议保持窗口前台或分屏可见。'
        );
      }

      if (this.data.cfDetected) {
        safetyLevel = 'Warning';
        safetySummary = '检测到 Cloudflare 人机挑战';
        issues.push('页面出现 Cloudflare 验证码挑战，请手动在浏览器中点击通过验证。');
      }

      if (recentTiming && recentTiming.status === 429) {
        safetyLevel = 'Warning';
        safetySummary = '触发服务器限频 (HTTP 429)';
        issues.push('观察到 HTTP 429，浏览任务已暂停，不会自动重试。请检查网站提示并遵守站点限制。');
      }

      return {
        safetyLevel,
        safetySummary,
        isHidden,
        hasFocus,
        timingOk,
        recentTiming,
        issues,
        trackers: this.data.trackersDetected,
        challengeDetected: this.data.cfDetected,
        successCount: this.data.timingsSuccessCount,
        errorCount: this.data.timingsErrorCount,
      };
    },
  };

  /* ==========================================================================
   * 9. 可调速浏览辅助引擎
   * ========================================================================== */

  const browseState = {
    running: false, paused: false, pauseReason: '',
    completedTopics: 0, completedPosts: 0, currentTopicPostsRead: 0,
    currentFloor: 1, status: 'idle', statusText: '待命', statusCountdown: 0,
    startedAt: 0, currentTopicId: null, readPostKeys: [],
    history: (() => { const value = store.get(STORE_KEY_BROWSE_HISTORY, []); return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []; })(),
  };
  let browseRunId = 0;
  let activeBrowseStep = null;

  function loadBrowseState() {
    // Session storage scopes a running task to its original tab, not every logged-in tab.
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY_BROWSE_STATE) || 'null');
      if (!saved || !saved.running || !browseConfig.autoResume) return;
      for (const key of ['completedTopics', 'completedPosts', 'currentTopicPostsRead', 'startedAt', 'currentFloor']) {
        if (Number.isFinite(saved[key]) && saved[key] >= 0) browseState[key] = saved[key];
      }
      browseState.currentTopicId = typeof saved.currentTopicId === 'string' ? saved.currentTopicId : null;
      browseState.readPostKeys = Array.isArray(saved.readPostKeys) ? saved.readPostKeys.filter((key) => typeof key === 'string') : [];
      browseState.running = true;
      browseState.paused = !!saved.paused || browseConfig.speedPercent === 0;
      browseState.pauseReason = saved.paused ? String(saved.pauseReason || 'manual') : browseConfig.speedPercent === 0 ? 'speed' : '';
      browseState.status = browseState.paused ? 'paused' : 'reading';
      browseState.statusText = browseState.paused ? '浏览任务已暂停，需手动恢复' : '正在恢复本标签页的浏览任务';
    } catch (_) {}
  }

  function persistBrowseState() {
    try {
      sessionStorage.setItem(STORE_KEY_BROWSE_STATE, JSON.stringify({
        running: browseState.running, paused: browseState.paused, pauseReason: browseState.pauseReason,
        completedTopics: browseState.completedTopics, completedPosts: browseState.completedPosts,
        currentTopicPostsRead: browseState.currentTopicPostsRead, currentFloor: browseState.currentFloor,
        currentTopicId: browseState.currentTopicId, readPostKeys: browseState.readPostKeys,
        startedAt: browseState.startedAt,
      }));
    } catch (_) {}
    store.set(STORE_KEY_BROWSE_HISTORY, browseState.history);
  }

  function scaleBrowseDelay(baseSeconds) {
    return browseConfig.speedPercent === 0 ? Infinity : baseSeconds * 10 / browseConfig.speedPercent;
  }

  function browseCanAdvance(token = browseRunId) {
    return browseState.running && token === browseRunId && !browseState.paused &&
      browseConfig.speedPercent > 0 && !document.hidden && !riskDetector.data.cfDetected;
  }

  function checkBrowseSafety() {
    riskDetector.scanPage();
    if (document.hidden) autoBrowse.suspend('hidden', '页面已隐藏，浏览已暂停；返回后请手动恢复');
    else if (riskDetector.data.cfDetected) autoBrowse.suspend('challenge', '页面出现验证，浏览已暂停；请手动处理');
    else if (browseConfig.speedPercent === 0 && !browseState.paused) autoBrowse.suspend('speed', '速度为 0%，浏览已暂停');
  }

  // Consume baseline work at the live selected rate. Paused time never accrues.
  async function waitBrowseDelay(baseSeconds, label = '', token = browseRunId, onTick) {
    let remaining = Math.max(0, Number(baseSeconds) || 0);
    let last = Date.now();
    let lastRender = -Infinity;
    while (browseState.running && token === browseRunId) {
      checkBrowseSafety();
      const now = Date.now();
      if (browseCanAdvance(token)) remaining -= Math.max(0, now - last) / 1000 * browseConfig.speedPercent / 10;
      last = now;
      if (remaining <= 0 && browseCanAdvance(token)) return true;
      browseState.statusCountdown = Number.isFinite(scaleBrowseDelay(remaining)) ? Math.ceil(scaleBrowseDelay(remaining)) : 0;
      if (!browseState.paused && label) {
        browseState.statusText = `${label} · ${browseConfig.speedPercent}% · 剩余 ${browseState.statusCountdown}s`;
      }
      if (onTick) onTick(browseState.statusCountdown);
      if (now - lastRender >= 250) {
        renderHud();
        if (state.panelOpen && state.activeTab === 'browse') renderBrowseStatus();
        lastRender = now;
      }
      // Yield to the browser event loop; faster playback does not multiply UI refreshes.
      await sleep(browseCanAdvance(token) ? Math.min(250, Math.max(25, scaleBrowseDelay(remaining) * 1000)) : 250);
    }
    return false;
  }

  function smoothBrowseScrollTo(targetY, durationMs, token = browseRunId) {
    return new Promise((resolve) => {
      const startY = window.scrollY || window.pageYOffset || 0;
      const distance = targetY - startY;
      const duration = Math.max(400, durationMs || Math.abs(distance));
      let elapsed = 0;
      let last = performance.now();
      function frame(now) {
        if (!browseState.running || token !== browseRunId) { resolve(false); return; }
        checkBrowseSafety();
        if (browseCanAdvance(token)) {
          elapsed += Math.max(0, now - last) * browseConfig.speedPercent / 10;
          const progress = Math.min(1, elapsed / duration);
          const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
          window.scrollTo(0, startY + distance * ease);
          if (progress >= 1) { resolve(true); return; }
        }
        last = now;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  function calculatePostDwell(text) {
    const base = randomRange(browseConfig.minPostDwellSeconds, browseConfig.maxPostDwellSeconds);
    const extra = Math.min(10, Math.floor(String(text || '').length / browseConfig.charsPerSecond));
    return Math.max(6, base + extra);
  }

  function startCountdown(seconds, onTick, onComplete) {
    return waitBrowseDelay(seconds, '', browseRunId, onTick).then((ok) => { if (ok) onComplete(); });
  }

  function topicLink(link) {
    try {
      const url = new URL(link.getAttribute('href') || link.href, location.href);
      if (url.protocol !== 'https:' || url.origin !== location.origin) return null;
      const parsed = parseTopicPath(url.pathname);
      return parsed ? { url, topicId: parsed.topicId, el: link } : null;
    } catch (_) { return null; }
  }

  const autoBrowse = {
    start() {
      if (browseState.running) return this.step();
      browseRunId++;
      activeBrowseStep = null;
      Object.assign(browseState, {
        running: true, paused: browseConfig.speedPercent === 0,
        pauseReason: browseConfig.speedPercent === 0 ? 'speed' : '',
        startedAt: Date.now(), completedTopics: 0, completedPosts: 0,
        currentTopicId: null, currentTopicPostsRead: 0, readPostKeys: [],
        status: browseConfig.speedPercent === 0 ? 'paused' : 'reading',
        statusText: browseConfig.speedPercent === 0 ? '速度为 0%，浏览已暂停' : '浏览辅助已启动',
      });
      checkBrowseSafety();
      persistBrowseState();
      renderHud(); renderFab();
      if (state.panelOpen) renderPanel();
      return this.step();
    },

    suspend(reason, text) {
      if (!browseState.running || (browseState.paused && browseState.pauseReason === reason)) return;
      browseState.paused = true;
      browseState.pauseReason = reason;
      browseState.status = 'paused';
      browseState.statusText = text;
      persistBrowseState(); renderHud(); renderFab();
      if (state.panelOpen) renderPanel();
    },

    pause() {
      if (!browseState.running) return;
      if (!browseState.paused) { this.suspend('manual', '任务已手动暂停'); return; }
      riskDetector.scanPage();
      if (document.hidden) {
        showToast('当前页面已隐藏，请切回页面后恢复'); return;
      }
      if (riskDetector.data.cfDetected) {
        showToast('检测到可见验证，请先手动处理后恢复'); return;
      }
      if (browseConfig.speedPercent === 0) {
        showToast('浏览速度为 0%，请先设置非零速度'); return;
      }
      browseState.paused = false; browseState.pauseReason = '';
      browseState.status = 'reading'; browseState.statusText = '任务已恢复';
      persistBrowseState(); renderHud(); renderFab();
      if (state.panelOpen) renderPanel();
      return this.step();
    },

    stop(reason) {
      browseRunId++;
      activeBrowseStep = null;
      browseState.running = false; browseState.paused = false; browseState.pauseReason = '';
      browseState.status = 'done'; browseState.statusCountdown = 0;
      browseState.statusText = reason === 'target_met' ? '已达到本地浏览上限' : reason === 'no_topics' ? '没有新的可浏览话题，任务已结束' : '任务已停止';
      persistBrowseState(); renderHud(); renderFab();
      if (state.panelOpen) renderPanel();
    },

    onRouteChange() {
      browseRunId++;
      activeBrowseStep = null;
    },

    step() {
      if (!browseState.running || browseState.paused) return Promise.resolve();
      if (activeBrowseStep) return activeBrowseStep;
      const token = browseRunId;
      const work = (async () => {
        checkBrowseSafety();
        if (!browseCanAdvance(token)) return;
        if (browseState.completedTopics >= browseConfig.targetTopics || browseState.completedPosts >= browseConfig.targetPosts) {
          this.stop('target_met'); return;
        }
        if (isTopicPage()) await this.readCurrentTopic(token);
        else await this.findAndEnterNextTopic(token);
      })().catch((err) => {
        console.error('[有一说一] 浏览失败:', err);
        if (token === browseRunId) this.suspend('error', '浏览失败，请检查页面后手动恢复');
      }).finally(() => {
        if (activeBrowseStep === work) activeBrowseStep = null;
      });
      activeBrowseStep = work;
      return work;
    },

    async readCurrentTopic(token) {
      const topicId = parseTopicPath(location.pathname)?.topicId;
      if (!topicId || !(await waitForContent(8000)) || !browseCanAdvance(token)) return;
      let articles = $$('article[data-post-id]');
      if (!articles.length) { this.suspend('content', '没有加载到帖子正文，请手动检查'); return; }
      if (browseState.currentTopicId !== topicId) {
        browseState.currentTopicId = topicId; browseState.currentTopicPostsRead = 0;
        browseState.readPostKeys = [];
        if (!browseState.history.includes(topicId)) browseState.history.push(topicId);
        browseState.completedTopics++;
        persistBrowseState();
      }
      while (browseState.currentTopicPostsRead < browseConfig.maxPostsPerTopic) {
        articles = $$('article[data-post-id]');
        const article = articles.find((el) => !browseState.readPostKeys.includes(el.getAttribute('data-post-id')));
        if (!article) break;
        if (browseState.completedPosts >= browseConfig.targetPosts) { this.stop('target_met'); return; }
        const key = article.getAttribute('data-post-id');
        const floor = extractPostFloor(article) || browseState.currentTopicPostsRead + 1;
        browseState.currentFloor = floor;
        const targetY = Math.max(0, article.getBoundingClientRect().top + window.scrollY - 130);
        if (!(await smoothBrowseScrollTo(targetY, 800, token))) return;
        if (!(await waitBrowseDelay(calculatePostDwell(extractPostText(article)), `正在浏览 #${floor} 楼`, token))) return;
        if (!browseCanAdvance(token) || !article.isConnected) return;
        browseState.readPostKeys.push(key); browseState.completedPosts++; browseState.currentTopicPostsRead++;
        persistBrowseState(); renderHud();
      }
      await this.handleTopicFinished(token);
    },

    async handleTopicFinished(token) {
      if (!browseCanAdvance(token)) return;
      if (browseState.completedTopics >= browseConfig.targetTopics || browseState.completedPosts >= browseConfig.targetPosts) {
        this.stop('target_met'); return;
      }
      const rest = browseState.completedTopics % browseConfig.fatigueInterval === 0;
      browseState.status = rest ? 'resting' : 'cooling';
      if (!(await waitBrowseDelay(rest ? browseConfig.fatigueRestSeconds : browseConfig.cooldownSeconds, rest ? '阶段休息' : '话题切换等待', token))) return;
      if (browseCanAdvance(token)) location.href = '/latest';
    },

    async findAndEnterNextTopic(token) {
      if (!(await waitBrowseDelay(1.5, '检查话题列表', token))) return;
      const chosen = $$('.topic-list-item a.title, a.raw-topic-link').map(topicLink)
        .find((item) => item && !browseState.history.includes(item.topicId));
      if (!chosen) { this.stop('no_topics'); return; }
      if (!(await waitBrowseDelay(1, '准备打开话题', token))) return;
      if (!browseCanAdvance(token)) return;
      if (browseState.history.includes(chosen.topicId)) return this.findAndEnterNextTopic(token);
      browseState.history.push(chosen.topicId);
      persistBrowseState();
      chosen.el.click();
    },

    onPageLoad() {
      if (browseState.running && !browseState.paused) this.step();
    },
  };


  /* ==========================================================================
   * 10. 样式 (CSS)
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
    --ldya-warn: #d97706;
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

  /* 悬浮微型状态胶囊 (HUD) */
  .ldya-hud {
    position: absolute;
    right: 0;
    bottom: 56px;
    display: none;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: 20px;
    background: var(--ldya-bg);
    color: var(--ldya-fg);
    border: 1px solid var(--ldya-line);
    box-shadow: 0 10px 25px rgba(0, 0, 0, .14);
    font-size: 12.5px;
    font-weight: 500;
    white-space: nowrap;
    animation: ldya-in .2s ease-out;
  }
  .ldya-hud[data-show="1"] { display: flex; }
  .ldya-hud__dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--ldya-ready);
    animation: ldya-pulse 1.8s ease-out infinite;
  }
  .ldya-hud__dot[data-status="paused"] { background: var(--ldya-warn); animation: none; }
  .ldya-hud__dot[data-status="cooling"] { background: var(--ldya-loading); }
  .ldya-hud__dot[data-status="resting"] { background: #8b5cf6; }
  .ldya-hud__title { font-weight: 700; cursor: pointer; color: var(--ldya-fg); }
  .ldya-hud__title:hover { text-decoration: underline; }
  .ldya-hud__text { color: var(--ldya-sub); font-size: 12px; }
  .ldya-hud__btn {
    border: 0; background: var(--ldya-soft); border-radius: 6px;
    padding: 2px 7px; font-size: 11.5px; font-weight: 600;
    color: var(--ldya-sub); cursor: pointer;
    transition: background .15s ease, color .15s ease;
  }
  .ldya-hud__btn:hover { background: var(--ldya-line); color: var(--ldya-fg); }

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
  .ldya-fab[data-status="browsing"] { background: #059669; }

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

  /* 主面板 */
  .ldya-panel {
    position: absolute;
    right: 0;
    bottom: 58px;
    width: min(440px, calc(100vw - 32px));
    max-height: min(74vh, 680px);
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
    flex-direction: column;
    border-bottom: 1px solid var(--ldya-line);
    background: var(--ldya-soft);
  }
  .ldya-hd__top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 14px 6px;
  }
  .ldya-hd__title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
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

  /* 导航 Tab */
  .ldya-tabs {
    display: flex;
    gap: 4px;
    padding: 0 10px 8px;
  }
  .ldya-tab-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ldya-sub);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: all .15s ease;
  }
  .ldya-tab-btn:hover { background: rgba(120, 130, 145, .12); color: var(--ldya-fg); }
  .ldya-tab-btn.active {
    background: var(--ldya-bg);
    color: var(--ldya-fg);
    box-shadow: 0 2px 6px rgba(0, 0, 0, .08);
  }
  .ldya-tab-badge {
    padding: 1px 5px;
    border-radius: 6px;
    font-size: 10px;
    background: rgba(22, 163, 74, .15);
    color: var(--ldya-ready);
  }

  .ldya-body {
    padding: 14px;
    overflow-y: auto;
    font-size: 13px;
    line-height: 1.65;
  }
  .ldya-body::-webkit-scrollbar { width: 8px; }
  .ldya-body::-webkit-scrollbar-thumb { background: rgba(120, 130, 145, .35); border-radius: 4px; }

  /* 回帖助手主体 */
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
    font-size: 14px;
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
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
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
  .ldya-btn--danger { background: var(--ldya-error); border-color: var(--ldya-error); color: #fff; }
  .ldya-btn--danger:hover { background: #b91c1c; border-color: #b91c1c; }
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
    max-height: 200px;
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

  /* 浏览辅助卡片与进度条 */
  .ldya-card {
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--ldya-soft);
    border: 1px solid var(--ldya-line);
    margin-bottom: 12px;
  }
  .ldya-card__title { font-size: 13px; font-weight: 700; color: var(--ldya-fg); margin-bottom: 8px; }
  .ldya-progress-box { margin-top: 8px; }
  .ldya-progress-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--ldya-sub); margin-bottom: 4px; }
  .ldya-progress {
    height: 6px; border-radius: 3px; background: var(--ldya-line); overflow: hidden;
  }
  .ldya-progress__fill {
    height: 100%; border-radius: 3px; background: var(--ldya-ready);
    transition: width .3s ease;
  }
  .ldya-status-banner {
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(37, 99, 235, .08);
    border: 1px solid rgba(37, 99, 235, .2);
    color: var(--ldya-loading);
    font-size: 12.5px;
    font-weight: 500;
    margin-bottom: 12px;
  }
  .ldya-status-banner[data-state="paused"] {
    background: rgba(217, 119, 6, .08); border-color: rgba(217, 119, 6, .25); color: var(--ldya-warn);
  }
  .ldya-status-banner[data-state="done"] {
    background: rgba(22, 163, 74, .08); border-color: rgba(22, 163, 74, .25); color: var(--ldya-ready);
  }

  /* 风控监测卡片 */
  .ldya-badge-score {
    display: inline-flex; align-items: center; padding: 2px 8px;
    border-radius: 12px; font-size: 12px; font-weight: 800;
  }
  .ldya-badge-score--a { background: rgba(22, 163, 74, .15); color: #16a34a; }
  .ldya-badge-score--b { background: rgba(217, 119, 6, .15); color: #d97706; }
  .ldya-badge-score--warn { background: rgba(220, 38, 38, .15); color: #dc2626; }

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
   * 11. UI 渲染与交互
   * ========================================================================== */

  let root = null;
  let fab = null;
  let hud = null;
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

    // 悬浮微型状态 HUD
    hud = document.createElement('div');
    hud.className = 'ldya-hud';
    hud.innerHTML = `
      <span class="ldya-hud__dot"></span>
      <span class="ldya-hud__title" data-act="open-panel">浏览辅助中</span>
      <span class="ldya-hud__text"></span>
      <button class="ldya-hud__btn" data-act="hud-pause">暂停</button>
      <button class="ldya-hud__btn" data-act="hud-stop">结束</button>
    `;

    hud.addEventListener('click', (e) => {
      const act = e.target.getAttribute('data-act');
      if (act === 'open-panel') {
        state.activeTab = 'browse';
        togglePanel(true);
      } else if (act === 'hud-pause') {
        autoBrowse.pause();
      } else if (act === 'hud-stop') {
        autoBrowse.stop('manual');
      }
    });

    fab = document.createElement('button');
    fab.type = 'button';
    fab.id = APP + '-fab';
    fab.className = 'ldya-fab';
    fab.innerHTML =
      '<span class="ldya-fab__icon"></span><span class="ldya-fab__text">有一说一</span><span class="ldya-fab__badge"></span>';
    fab.addEventListener('click', () => togglePanel());

    toastEl = document.createElement('div');
    toastEl.className = 'ldya-toast';

    root.appendChild(hud);
    root.appendChild(fab);
    root.appendChild(toastEl);
    document.body.appendChild(root);
    renderFab();
    renderHud();
    return root;
  }

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.setAttribute('data-show', '1');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.setAttribute('data-show', '0'), 2000);
  }

  const ICONS = {
    idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 8.6 7.9z"/></svg>',
    loading:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 8.6 7.9z"/></svg>',
    ready:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
    browsing:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  };

  function fabText() {
    if (browseState.running) {
      if (browseState.paused) return '浏览已暂停';
      return `浏览中 ${browseState.completedTopics}/${browseConfig.targetTopics}`;
    }
    if (state.status === 'loading') {
      const seconds = Math.max(0, Math.round(state.elapsed / 1000));
      return '生成中 ' + seconds + 's';
    }
    if (state.status === 'ready') return '看回复';
    if (state.status === 'error') return '生成失败';
    return isTopicPage() ? '有一说一' : '回帖 / 浏览助手';
  }

  function renderFab() {
    if (!fab) return;
    const currentStatus = browseState.running ? 'browsing' : state.status;
    fab.setAttribute('data-status', currentStatus);
    const icon = fab.querySelector('.ldya-fab__icon');
    const text = fab.querySelector('.ldya-fab__text');
    if (icon) {
      icon.innerHTML =
        state.status === 'loading' && !browseState.running
          ? '<span class="ldya-fab__spinner"></span>'
          : ICONS[currentStatus] || ICONS.idle;
    }
    if (text) text.textContent = fabText();
    fab.title = browseState.running
      ? '正在拟人化慢速浏览，点击查看控制面板'
      : state.status === 'ready'
      ? '回复已生成，点击查看'
      : '有一说一 · 回帖与浏览辅助助手';
  }

  function renderHud() {
    if (!hud) return;
    if (!browseState.running) {
      hud.setAttribute('data-show', '0');
      return;
    }
    hud.setAttribute('data-show', '1');
    const dot = hud.querySelector('.ldya-hud__dot');
    const title = hud.querySelector('.ldya-hud__title');
    const text = hud.querySelector('.ldya-hud__text');
    const pauseBtn = hud.querySelector('[data-act="hud-pause"]');

    if (dot) dot.setAttribute('data-status', browseState.status);
    if (title) title.textContent = browseState.paused ? '浏览辅助(暂停)' : '浏览辅助中';
    if (pauseBtn) pauseBtn.textContent = browseState.paused ? '继续' : '暂停';
    if (text) {
      text.textContent = `话题 ${browseState.completedTopics}/${browseConfig.targetTopics} · 帖子 ${browseState.completedPosts}/${browseConfig.targetPosts} · ${browseState.statusText}`;
    }
  }

  function togglePanel(force) {
    const open = typeof force === 'boolean' ? force : !state.panelOpen;
    state.panelOpen = open;
    if (open) {
      ensureRoot();
      if (!panel || !root.contains(panel)) {
        panel = document.createElement('div');
        panel.id = APP + '-panel';
        panel.className = 'ldya-panel';
        root.appendChild(panel);
      }
      panel.style.display = 'flex';
      renderPanel();
      if (state.status === 'idle' && config.auto === false && isTopicPage()) {
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

  function renderBrowseStatus() {
    if (!panel) return;
    const banner = panel.querySelector('.ldya-status-banner');
    if (banner) {
      banner.setAttribute('data-state', browseState.status);
      banner.textContent = browseState.statusText;
    }
    const topicFill = panel.querySelector('#ldya-topic-fill');
    const topicText = panel.querySelector('#ldya-topic-text');
    if (topicFill && topicText) {
      const pct = Math.min(100, Math.round((browseState.completedTopics / Math.max(1, browseConfig.targetTopics)) * 100));
      topicFill.style.width = pct + '%';
      topicText.textContent = `${browseState.completedTopics} / ${browseConfig.targetTopics} (${pct}%)`;
    }
    const postFill = panel.querySelector('#ldya-post-fill');
    const postText = panel.querySelector('#ldya-post-text');
    if (postFill && postText) {
      const pct = Math.min(100, Math.round((browseState.completedPosts / Math.max(1, browseConfig.targetPosts)) * 100));
      postFill.style.width = pct + '%';
      postText.textContent = `${browseState.completedPosts} / ${browseConfig.targetPosts} (${pct}%)`;
    }
  }

  /* --------------------------------------------------------------------------
   * 渲染三大 Tab 内容
   * ------------------------------------------------------------------------ */

  function renderReplyTabHtml() {
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
        (isTopicPage() ? '还没有生成回复。' : '当前在列表页。进入任意帖子详情页即可自动生成回复。') +
        '</div>' +
        (isTopicPage()
          ? '<div class="ldya-row"><button class="ldya-btn ldya-btn--primary" data-act="regen">生成回复</button></div>'
          : '');
    }

    // 设置区
    bodyHtml +=
      '<details class="ldya-more ldya-settings"' +
      (state.settingsOpen ? ' open' : '') +
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

    return bodyHtml;
  }

  function renderBrowseTabHtml() {
    const isRunning = browseState.running;
    const isPaused = browseState.paused;
    const topicPct = Math.min(100, Math.round((browseState.completedTopics / Math.max(1, browseConfig.targetTopics)) * 100));
    const postPct = Math.min(100, Math.round((browseState.completedPosts / Math.max(1, browseConfig.targetPosts)) * 100));

    return `
      <div class="ldya-status-banner" data-state="${browseState.status}">
        ${escapeHtml(browseState.statusText)}
      </div>

      <div class="ldya-card">
        <div class="ldya-card__title">🧭 任务进度统计</div>
        <div class="ldya-progress-box">
          <div class="ldya-progress-label">
            <span>浏览话题数</span>
            <span id="ldya-topic-text">${browseState.completedTopics} / ${browseConfig.targetTopics} (${topicPct}%)</span>
          </div>
          <div class="ldya-progress"><div class="ldya-progress__fill" id="ldya-topic-fill" style="width:${topicPct}%"></div></div>
        </div>

        <div class="ldya-progress-box" style="margin-top:10px;">
          <div class="ldya-progress-label">
            <span>细读帖子数</span>
            <span id="ldya-post-text">${browseState.completedPosts} / ${browseConfig.targetPosts} (${postPct}%)</span>
          </div>
          <div class="ldya-progress"><div class="ldya-progress__fill" id="ldya-post-fill" style="width:${postPct}%"></div></div>
        </div>

        <div class="ldya-row" style="margin-top:14px;">
          ${
            !isRunning
              ? '<button class="ldya-btn ldya-btn--primary" data-act="browse-start" style="flex:1;">▶ 开始浏览辅助</button>'
              : `<button class="ldya-btn" data-act="browse-pause" style="flex:1;">${isPaused ? '▶ 恢复' : '⏸ 暂停'}</button>
                 <button class="ldya-btn ldya-btn--danger" data-act="browse-stop">⏹ 结束</button>`
          }
        </div>
      </div>

      <details class="ldya-more ldya-browse-settings" open>
        <summary>⚙️ 浏览速度与操作上限</summary>
        <div class="ldya-field">
          <label for="ldya-browse-speed">浏览速度：<output id="ldya-speed-value">${browseConfig.speedPercent}%</output></label>
          <input id="ldya-browse-speed" class="ldya-input" data-bfield="speedPercent" type="range" min="0" max="100" step="1" value="${browseConfig.speedPercent}" />
          <div class="ldya-hint">0% 暂停 · 默认 10%＝基础速度（1×）· 100%＝十倍速度（10×）；同时控制帖子滚动、停留、话题切换和阶段休息。异步等待和逐帧滚动，不阻塞浏览器操作。</div>
        </div>
        <div class="ldya-field">
          <label>目标浏览话题数 (建议 8~25 篇/天)</label>
          <input class="ldya-input" data-bfield="targetTopics" type="number" min="1" max="100" value="${browseConfig.targetTopics}" />
        </div>
        <div class="ldya-field">
          <label>目标细读帖子数 (建议 30~100 楼/天)</label>
          <input class="ldya-input" data-bfield="targetPosts" type="number" min="5" max="300" value="${browseConfig.targetPosts}" />
        </div>
        <div class="ldya-field">
          <label>每话题细读楼层上限 (建议 4~8 楼)</label>
          <input class="ldya-input" data-bfield="maxPostsPerTopic" type="number" min="2" max="25" value="${browseConfig.maxPostsPerTopic}" />
        </div>
        <div class="ldya-field">
          <label>单楼层基础停留时间范围 (10% 速度下，默认 6~15 秒)</label>
          <div style="display:flex; gap:8px;">
            <input class="ldya-input" data-bfield="minPostDwellSeconds" type="number" min="6" max="120" value="${browseConfig.minPostDwellSeconds}" placeholder="最少" />
            <input class="ldya-input" data-bfield="maxPostDwellSeconds" type="number" min="6" max="120" value="${browseConfig.maxPostDwellSeconds}" placeholder="最多" />
          </div>
        </div>
        <div class="ldya-field">
          <label>换话题基础等待时间 (10% 速度下，至少 18 秒)</label>
          <input class="ldya-input" data-bfield="cooldownSeconds" type="number" min="18" max="600" value="${browseConfig.cooldownSeconds}" />
        </div>
        <div class="ldya-row" style="margin-top:10px;">
          <button class="ldya-btn" data-act="clear-history">清空已读话题历史 (${browseState.history.length})</button>
        </div>
        <div class="ldya-hint">以上进度是本地操作计数，不代表网站确认的已读数据。低速也不保证账号安全；不伪造鼠标活动、不绕过验证或站点空闲检测。</div>
      </details>
    `;
  }

  function renderMonitorTabHtml() {
    const report = riskDetector.getReport();
    const scoreCls =
      report.safetyLevel === 'A+' ? 'ldya-badge-score--a' : report.safetyLevel === 'B' ? 'ldya-badge-score--b' : 'ldya-badge-score--warn';

    return `
      <div class="ldya-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span class="ldya-card__title" style="margin:0;">🛡️ 页面信号观察（非账号安全评级）</span>
          <span class="ldya-badge-score ${scoreCls}">${escapeHtml(report.safetyLevel)}</span>
        </div>
        <div style="font-size:12.5px; color:var(--ldya-fg); font-weight:500;">
          ${escapeHtml(report.safetySummary)}
        </div>
      </div>

      <div class="ldya-card">
        <div class="ldya-card__title">📡 已读信标同步状态 (/topics/timings)</div>
        <dl class="ldya-kv">
          <dt>最近同步</dt>
          <dd>${
            report.recentTiming
              ? `${formatClock(report.recentTiming.time)} (${report.recentTiming.duration}ms)`
              : '尚未触发（进入话题后滚动自动同步）'
          }</dd>
          <dt>HTTP 状态</dt>
          <dd>${
            report.recentTiming
              ? report.recentTiming.status === 200
                ? '<span style="color:#16a34a; font-weight:700;">200 OK（不代表已读计数确认）</span>'
                : `<span style="color:#dc2626; font-weight:700;">HTTP ${report.recentTiming.status}</span>`
              : '-'
          }</dd>
          <dt>累计信标请求</dt>
          <dd>成功 ${report.successCount} 次 / 失败 ${report.errorCount} 次</dd>
        </dl>
      </div>

      <div class="ldya-card">
        <div class="ldya-card__title">👁️ 视口与活跃度 (Discourse 依赖检测)</div>
        <dl class="ldya-kv">
          <dt>页面可见性</dt>
          <dd>${
            report.isHidden
              ? '<span style="color:#d97706; font-weight:700;">⚠️ 后台/隐藏 (Discourse 暂停计时!)</span>'
              : '<span style="color:#16a34a; font-weight:700;">🟢 前台可见 (正常计时)</span>'
          }</dd>
          <dt>窗口焦点</dt>
          <dd>${report.hasFocus ? '🟢 拥有窗口焦点' : '⚠️ 失去焦点 (分屏可见仍有效)'}</dd>
          <dt>验证元素</dt>
          <dd>${report.challengeDetected ? '检测到验证，请手动处理' : '未发现已识别的验证元素（不代表没有风控）'}</dd>
        </dl>
      </div>

      ${
        report.trackers && report.trackers.length
          ? `<div class="ldya-card">
              <div class="ldya-card__title">🔍 页面检测到的遥测 / 埋点 SDK</div>
              <div style="font-size:12px; color:var(--ldya-sub);">
                ${report.trackers.map((t) => `• ${escapeHtml(t)}`).join('<br/>')}
              </div>
            </div>`
          : ''
      }

      ${
        report.issues.length
          ? `<div class="ldya-error" style="margin-top:10px;">
              ${report.issues.map((i) => `⚠️ ${escapeHtml(i)}`).join('\n\n')}
            </div>`
          : ''
      }

      <div class="ldya-card" style="margin-top:12px;">
        <div class="ldya-card__title">📖 使用边界</div>
        <div style="font-size:12px; color:var(--ldya-sub); line-height:1.7;">
          1. 不直接发送或伪造已读计时请求，不模拟鼠标活动。<br/>
          2. 观察到验证、HTTP 403/429 或页面隐藏时暂停，需手动恢复。<br/>
          3. 前端检测不是完整风控审计，短时间未出现验证也不代表不会封号；请遵守社区规则。
        </div>
      </div>
    `;
  }

  function renderPanel() {
    if (!panel) return;

    let bodyHtml = '';
    if (state.activeTab === 'reply') {
      bodyHtml = renderReplyTabHtml();
    } else if (state.activeTab === 'browse') {
      bodyHtml = renderBrowseTabHtml();
    } else if (state.activeTab === 'monitor') {
      bodyHtml = renderMonitorTabHtml();
    }

    panel.innerHTML = `
      <div class="ldya-hd">
        <div class="ldya-hd__top">
          <div class="ldya-hd__title">
            <span class="ldya-hd__dot" data-status="${state.status}"></span>
            有一说一 · 助手
            <span class="ldya-hd__meta"></span>
          </div>
          <div class="ldya-hd__btns">
            <button class="ldya-icon-btn" data-act="refresh" title="重新检测/刷新">⟳</button>
            <button class="ldya-icon-btn" data-act="close" title="关闭面板">✕</button>
          </div>
        </div>
        <div class="ldya-tabs">
          <button class="ldya-tab-btn ${state.activeTab === 'reply' ? 'active' : ''}" data-tab="reply">
            💬 回帖助手
          </button>
          <button class="ldya-tab-btn ${state.activeTab === 'browse' ? 'active' : ''}" data-tab="browse">
            🧭 浏览辅助 <span class="ldya-tab-badge">新</span>
          </button>
          <button class="ldya-tab-btn ${state.activeTab === 'monitor' ? 'active' : ''}" data-tab="monitor">
            🛡️ 风控监测
          </button>
        </div>
      </div>
      <div class="ldya-body">
        ${bodyHtml}
      </div>
    `;

    renderPanelStatus();
    bindPanelEvents();
  }

  function bindPanelEvents() {
    if (!panel || panel.__bound) return;
    panel.__bound = true;

    panel.addEventListener('click', (event) => {
      // Tab 切换
      const tabBtn = event.target.closest('[data-tab]');
      if (tabBtn) {
        state.activeTab = tabBtn.getAttribute('data-tab');
        store.set(STORE_KEY_ACTIVE_TAB, state.activeTab);
        renderPanel();
        return;
      }

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
        if (state.activeTab === 'reply') runGenerate({ manual: true, force: true });
        else renderPanel();
        return;
      }
      if (act === 'settings') {
        state.settingsOpen = true;
        renderPanel();
        return;
      }
      if (act === 'browse-start') {
        autoBrowse.start();
        return;
      }
      if (act === 'browse-pause') {
        autoBrowse.pause();
        return;
      }
      if (act === 'browse-stop') {
        autoBrowse.stop('manual');
        return;
      }
      if (act === 'clear-history') {
        browseState.history = [];
        persistBrowseState();
        renderPanel();
        showToast('已清空浏览历史');
        return;
      }
    });

    panel.addEventListener(
      'toggle',
      (event) => {
        const target = event.target;
        if (target && target.classList && target.classList.contains('ldya-settings')) {
          state.settingsOpen = !!target.open;
        }
      },
      true
    );

    panel.addEventListener('input', (event) => {
      if (event.target.getAttribute?.('data-bfield') !== 'speedPercent') return;
      saveBrowseConfig({ speedPercent: event.target.value });
      event.target.value = String(browseConfig.speedPercent);
      const output = panel.querySelector('#ldya-speed-value');
      if (output) output.textContent = browseConfig.speedPercent + '%';
      renderBrowseStatus();
    });

    panel.addEventListener('change', (event) => {
      // 回帖助手配置
      const field = event.target.getAttribute && event.target.getAttribute('data-field');
      if (field) {
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
          return;
        }
      }

      // 浏览辅助配置
      const bfield = event.target.getAttribute && event.target.getAttribute('data-bfield');
      if (bfield) {
        if (bfield === 'speedPercent') {
          saveBrowseConfig({ speedPercent: event.target.value });
          showToast('浏览速度已保存：' + browseConfig.speedPercent + '%');
          renderPanel();
          return;
        }
        if (bfield === 'sourceList') {
          saveBrowseConfig({ sourceList: event.target.value });
          showToast('话题来源已切换');
          return;
        }
        const numVal = parseInt(event.target.value, 10);
        if (!isNaN(numVal)) {
          saveBrowseConfig({ [bfield]: numVal });
          event.target.value = String(browseConfig[bfield]);
          showToast('配置已更新');
        }
      }
    });
  }

  async function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        return true;
      }
    } catch (_) {}
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
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
   * 12. 回帖生成流程
   * ========================================================================== */

  function waitForContent(timeout) {
    const limit = timeout || CONTENT_WAIT_TIMEOUT;
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
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
   * 13. 路由监听：Discourse 是 SPA，需要拦截 pushState / popstate
   * ========================================================================== */

  let lastHref = location.href;
  let lastRouteId = '';

  function currentRouteSignature() {
    if (!isTopicPage()) return 'none';
    const parsed = parseTopicPath(location.pathname);
    return buildTopicKey(parsed);
  }

  function currentRouteId() {
    if (!isTopicPage()) return 'none';
    const parsed = parseTopicPath(location.pathname);
    const page = new URLSearchParams(location.search).get('page') || '';
    return parsed.topicId + '|' + page;
  }

  function handleRouteChange(source) {
    if (location.href === lastHref && source !== 'force') return;
    lastHref = location.href;

    showAll();
    ensureRoot();
    root.setAttribute('data-theme', detectTheme());

    const routeId = currentRouteId();
    if (routeId === lastRouteId && routeId !== 'none') {
      return;
    }
    lastRouteId = routeId;
    if (browseState.running) autoBrowse.onRouteChange();

    const signature = currentRouteSignature();

    if (!isTopicPage()) {
      state.status = 'idle';
      state.result = null;
      state.error = '';
      stopElapsedTimer();
      renderFab();
      renderHud();

      // 如果自动浏览正在运行且在列表页，触发列表页巡视
      if (browseState.running && !browseState.paused) {
        setTimeout(() => autoBrowse.step(), 1500);
      }
      return;
    }

    const cached = readCache(signature);
    if (cached) {
      state.topicKey = signature;
      state.input = cached.input || '';
      state.result = cached.result;
      state.elapsed = 0;
      setStatus('ready', { fromCache: true });
    } else {
      setStatus('idle', { result: null, error: '', elapsed: 0, input: '' });
      maybeAutoGenerate();
    }

    // 自动浏览任务若在运行中，进入当前话题进行细读
    if (browseState.running && !browseState.paused) {
      setTimeout(() => autoBrowse.step(), 1800);
    }
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

    setInterval(() => {
      if (location.href !== lastHref) handleRouteChange('poll');
    }, 800);

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
   * 14. 启动与全局暴露
   * ========================================================================== */

  function boot() {
    loadCache();
    loadBrowseState();
    riskDetector.init();
    ensureRoot();
    showAll();
    handleRouteChange('force');
    installRouter();

    if (isTopicPage()) {
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

    autoBrowse.onPageLoad();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 调试与外部脚本控制接口
  window.__LDYA__ = {
    version: VERSION,
    state: state,
    browseState: browseState,
    browseConfig: () => browseConfig,
    setBrowseSpeed: (value) => {
      saveBrowseConfig({ speedPercent: value });
      if (state.panelOpen) renderPanel();
      return browseConfig.speedPercent;
    },
    riskReport: () => riskDetector.getReport(),
    startBrowse: () => autoBrowse.start(),
    pauseBrowse: () => autoBrowse.pause(),
    stopBrowse: () => autoBrowse.stop('manual'),
    collect: collectTopic,
    buildInput: () => (collectTopic() ? buildInputText(collectTopic()) : ''),
    generate: () => runGenerate({ manual: true, force: true }),
    open: (tab) => {
      if (tab) state.activeTab = tab;
      togglePanel(true);
    },
  };
})();
