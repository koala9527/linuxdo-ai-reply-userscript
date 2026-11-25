/** Chrome helper for the userscript UI. No synthetic activity or read-timing requests. Node 22+. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'http://127.0.0.1:9222';

export function parseArgs(args = process.argv.slice(2)) {
  const options = { speed: 10, speedExplicit: false };
  for (const arg of args) {
    if (['--status', '--detect-risk', '--browse', '--pause', '--stop', '--start-chrome', '--help'].includes(arg)) options[arg.slice(2)] = true;
    else if (arg === '-h') options.help = true;
    else if (arg.startsWith('--speed=')) {
      const text = arg.slice(8), value = Number(text);
      if (!text.trim() || !Number.isInteger(value) || value < 0 || value > 100) throw new Error('--speed 必须是 0–100 的整数');
      options.speed = value; options.speedExplicit = true;
    } else if (arg.startsWith('--profile=')) options.profile = arg.slice(10);
    else throw new Error('未知参数：' + arg);
  }
  const commands = ['browse', 'pause', 'stop', 'start-chrome'].filter((key) => options[key]);
  if (commands.length > 1) throw new Error('--browse、--pause、--stop、--start-chrome 不能同时使用');
  if (!commands.length && !options.status && !options['detect-risk'] && !options.speedExplicit) options.help = true;
  return options;
}

export function isLinuxDoUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && ['linux.do', 'www.linux.do'].includes(url.hostname); }
  catch (_) { return false; }
}

export class CdpSession {
  constructor(url, timeout = 8000) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port !== '9222') throw new Error('只允许本机 9222 端口的 Chrome 调试连接');
    this.url = url; this.timeout = timeout; this.pending = new Map(); this.seq = 0;
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => { reject(new Error('Chrome 连接超时')); this.close(); }, this.timeout);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('Chrome WebSocket 连接失败')); this.close(); };
      this.ws.onclose = () => { clearTimeout(timer); reject(new Error('Chrome 连接已关闭')); this.rejectPending(); };
      this.ws.onmessage = ({ data }) => {
        let message;
        try { message = JSON.parse(data); } catch (_) { return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      };
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1) { reject(new Error('Chrome 尚未连接')); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 指令超时：' + method)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  rejectPending() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Chrome 连接已关闭')); }
    this.pending.clear();
  }
  close() { this.rejectPending(); try { this.ws?.close(); } catch (_) {} }
}

export const OBSERVE_PAGE = `(() => {
  const challenges = !!document.querySelector('.cf-turnstile, #challenge-stage, #cf-wrapper, iframe[src*="challenges.cloudflare.com"]');
  const scripts = Array.from(document.querySelectorAll('script[src]')).map(el => el.src);
  return {
    url: location.href, title: document.title, visibility: document.visibilityState,
    challengeElements: challenges,
    telemetryScripts: scripts.filter(src => /sentry|cloudflareinsights|googletagmanager|google-analytics|umami/i.test(src)),
    timingResourceCount: performance.getEntriesByType('resource').filter(entry => /\\/topics\\/timings(?:$|[?])/.test(entry.name)).length,
    userscriptInstalled: !!document.querySelector('#ldya-root'),
    notice: '只观察前端页面，不判断账号安全，不读取 Cookie 或伪造计时请求。'
  };
})()`;

export function controlScript(options) {
  return `(async () => {
    if (!(${isLinuxDoUrl.toString()})(location.href)) throw new Error('页面不属于 Linux.do');
    if (!document.querySelector('#ldya-root')) throw new Error('请先在此标签页安装或更新油猴脚本至 v1.3.0');
    let panel = document.querySelector('#ldya-panel');
    if (!panel || panel.style.display !== 'flex') document.querySelector('#ldya-root .ldya-fab')?.click();
    panel = document.querySelector('#ldya-panel');
    if (!panel) throw new Error('未找到脚本面板');
    panel.querySelector('[data-tab="browse"]')?.click();
    const input = panel.querySelector('[data-bfield="speedPercent"]');
    if (!input) throw new Error('未找到速度滑块，请更新脚本至 v1.3.0');
    ${options.browse || options.speedExplicit ? `input.value = ${JSON.stringify(options.speed)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));` : ''}
    const action = ${JSON.stringify(options.browse ? 'browse-start' : options.pause ? 'browse-pause' : options.stop ? 'browse-stop' : '')};
    if (action) {
      const button = panel.querySelector('[data-act="' + action + '"]');
      if (!button) throw new Error('当前状态没有该操作按钮：' + action);
      if (action === 'browse-pause' && panel.querySelector('.ldya-status-banner')?.dataset.state === 'paused') throw new Error('任务已经暂停；--pause 不会自动恢复任务');
      button.click();
    }
    return {
      speedPercent: Number(panel.querySelector('[data-bfield="speedPercent"]').value),
      state: panel.querySelector('.ldya-status-banner')?.dataset.state,
      message: panel.querySelector('.ldya-status-banner')?.textContent.trim()
    };
  })()`;
}

function startChrome(options) {
  if (!options.profile || !path.isAbsolute(options.profile)) throw new Error('--start-chrome 必须提供 --profile=专用配置目录的绝对路径；不会使用或复制个人登录配置');
  const personal = path.resolve(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
  const profile = path.resolve(options.profile), relative = path.relative(personal, profile);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('不能使用个人 Chrome User Data 目录或其子目录');
  const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].find(fs.existsSync);
  if (!exe) throw new Error('未找到 Google Chrome');
  const child = spawn(exe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--user-data-dir=' + profile, 'https://linux.do/latest'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => { console.error(err.message); process.exitCode = 1; }); child.unref();
  console.log('已请求启动专用调试 Chrome；需要你手动登录并安装脚本。');
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(`Chrome 浏览辅助（Node 22+）
  --status / --detect-risk  只读页面信号，不判断是否会封号
  --browse [--speed=10]     通过已安装的油猴脚本启动任务
  --speed=0..100            调整当前任务；0=暂停，默认10，100=基础速度
  --pause / --stop          暂停或结束已有任务
  --start-chrome --profile=ABSOLUTE_PATH  启动专用调试配置（须手动登录）
必须已有本机9222调试连接和Linux.do标签页；仅登录普通Chrome不足以启用CDP。`); return;
  }
  if (options['start-chrome']) { startChrome(options); return; }
  let tabs;
  try {
    const response = await fetch(ENDPOINT + '/json/list', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    tabs = await response.json();
  } catch (err) { throw new Error('无法连接本机 Chrome 调试端口 9222。普通已登录窗口不一定开启 CDP；未更改或重启你的浏览器。原因：' + err.message); }
  const target = tabs.find((tab) => tab.type === 'page' && isLinuxDoUrl(tab.url));
  if (!target?.webSocketDebuggerUrl) throw new Error('没有已打开的 Linux.do 调试标签页；不会创建或切换其他网站页面');
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.connect();
    const observed = await session.evaluate(OBSERVE_PAGE);
    if (!isLinuxDoUrl(observed.url)) throw new Error('标签页已经离开 Linux.do，已停止操作');
    if (options.status || options['detect-risk']) console.log(JSON.stringify(observed, null, 2));
    if (options.browse || options.pause || options.stop || options.speedExplicit) console.log(JSON.stringify(await session.evaluate(controlScript(options)), null, 2));
  } finally { session.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
