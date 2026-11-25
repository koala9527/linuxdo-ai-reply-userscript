import fs from 'node:fs';
import vm from 'node:vm';

// Run the real userscript without booting DOM UI or making network requests.
export function createHarness(scriptPath, saved = {}) {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  const values = new Map(Object.entries(saved));
  const listeners = new Map();
  const document = {
    readyState: 'loading', hidden: false, visibilityState: 'visible', title: 'Fixture',
    cookie: '', hasFocus: () => true,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(name, fn) { listeners.set(name, fn); },
  };
  const location = { href: 'https://linux.do/latest', origin: 'https://linux.do', pathname: '/latest', search: '' };
  const window = {
    scrollY: 0, pageYOffset: 0, innerHeight: 800,
    scrollTo(_x, y) { this.scrollY = y; },
    addEventListener() {}, dispatchEvent() { throw new Error('Synthetic input is forbidden'); },
  };
  const schedule = (fn, ms, repeat) => {
    const id = ++serial;
    timers.set(id, { fn, at: now + Math.max(1, ms), ms: Math.max(1, ms), repeat });
    return id;
  };
  const math = Object.create(Math);
  math.random = () => 0.5;
  const context = vm.createContext({
    window, document, location, console, Math: math, URL, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => now },
    GM_getValue: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    GM_setValue: (key, value) => values.set(key, value),
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: (key) => values.get('session:' + key) ?? null, setItem: (key, value) => values.set('session:' + key, value) },
    setTimeout: (fn, ms) => schedule(fn, ms, false),
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => schedule(() => fn(now), 16, false),
  });
  let source = fs.readFileSync(scriptPath, 'utf8');
  const marker = '  // 调试与外部脚本控制接口';
  if (!source.includes(marker)) throw new Error('Test instrumentation marker missing');
  source = source.replace(marker, `
  renderHud = renderFab = renderPanel = renderBrowseStatus = showToast = () => {};
  waitForContent = async () => true;
  window.__LDYA_TEST__ = {
    DEFAULT_BROWSE_CONFIG, browseState, autoBrowse, riskDetector, saveBrowseConfig,
    calculatePostDwell, loadBrowseState, persistBrowseState,
    startCountdown,
    ...(typeof smoothHumanScrollTo === 'function' ? { smoothHumanScrollTo } : {}),
    ...(typeof smoothBrowseScrollTo === 'function' ? { smoothBrowseScrollTo } : {}),
    ...(typeof normalizeBrowseSpeed === 'function' ? { normalizeBrowseSpeed } : {}),
    ...(typeof scaleBrowseDelay === 'function' ? { scaleBrowseDelay } : {}),
    ...(typeof waitBrowseDelay === 'function' ? { waitBrowseDelay } : {}),
    ...(typeof browseCanAdvance === 'function' ? { browseCanAdvance } : {}),
    ...(typeof topicLink === 'function' ? { topicLink } : {}),
    renderBrowseTabHtml,
  };
${marker}`);
  vm.runInContext(source, context, { filename: scriptPath });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    api: window.__LDYA__, internals: window.__LDYA_TEST__, document, location, window, values, listeners,
    async advance(ms) {
      await flush();
      const until = now + ms;
      while (true) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        now = next.timer.at;
        if (next.timer.repeat) next.timer.at += next.timer.ms;
        else timers.delete(next.id);
        next.timer.fn();
        await flush();
      }
      now = until;
      await flush();
    },
    timerCount: () => timers.size,
  };
}
