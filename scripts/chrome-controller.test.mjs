import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const { parseArgs, isLinuxDoUrl, CdpSession, controlScript } = await import(process.env.LDYA_TEST_CONTROLLER ? pathToFileURL(process.env.LDYA_TEST_CONTROLLER).href : './chrome-controller.mjs');

test('controller defaults to 10% and preserves speed zero', () => {
  assert.equal(parseArgs(['--browse']).speed, 10);
  assert.equal(parseArgs(['--speed=0']).speed, 0);
  assert.equal(parseArgs(['--speed=100']).speed, 100);
});
for (const value of ['-1', '101', '1.5', 'NaN', '', '50x']) test(`controller rejects invalid speed ${value}`, () => assert.throws(() => parseArgs(['--speed=' + value]), /0–100/));
test('controller rejects unknown or conflicting operations', () => {
  assert.throws(() => parseArgs(['--entire']), /未知参数/);
  assert.throws(() => parseArgs(['--browse', '--stop']), /不能同时/);
});
test('controller accepts only exact Linux.do HTTPS hosts', () => {
  for (const url of ['https://linux.do/t/123', 'https://www.linux.do/latest']) assert.equal(isLinuxDoUrl(url), true);
  for (const url of ['http://linux.do', 'https://linux.do.evil.test', 'https://evil.test/?linux.do', 'javascript:alert(1)']) assert.equal(isLinuxDoUrl(url), false);
});
test('controller accepts only loopback CDP endpoints', () => {
  assert.doesNotThrow(() => new CdpSession('ws://127.0.0.1:9222/devtools/page/1'));
  for (const url of ['ws://evil.test:9222/page/1', 'wss://localhost:9222/page/1', 'ws://127.0.0.1:9999/page/1']) assert.throws(() => new CdpSession(url), /本机/);
});
test('CDP send times out and removes pending commands', async () => {
  const session = new CdpSession('ws://127.0.0.1:9222/page/1', 10);
  session.ws = { readyState: 1, send() {}, close() {} };
  await assert.rejects(session.send('Runtime.evaluate'), /超时/);
  assert.equal(session.pending.size, 0);
});
test('CDP close rejects in-flight operations', async () => {
  const session = new CdpSession('ws://127.0.0.1:9222/page/1');
  session.ws = { readyState: 1, send() {}, close() {} };
  const work = session.send('Runtime.evaluate'); session.close();
  await assert.rejects(work, /关闭/); assert.equal(session.pending.size, 0);
});
test('DOM control opens lazy panel, sets slider, and starts the existing script only', async () => {
  const events = []; let started = 0; let opened = false;
  const input = { value: '10', dispatchEvent: (event) => events.push(event.type) };
  const banner = { dataset: { state: 'reading' }, textContent: '浏览辅助已启动' };
  const panel = { style: { display: 'flex' }, querySelector(selector) {
    if (selector.includes('speedPercent')) return input;
    if (selector.includes('browse-start')) return { click: () => started++ };
    if (selector.includes('data-tab')) return { click() {} };
    if (selector === '.ldya-status-banner') return banner;
    return null;
  } };
  const document = { querySelector(selector) {
    if (selector === '#ldya-root') return {};
    if (selector === '#ldya-panel') return opened ? panel : null;
    if (selector === '#ldya-root .ldya-fab') return { click: () => { opened = true; } };
    return null;
  } };
  const result = await vm.runInNewContext(controlScript(parseArgs(['--browse', '--speed=20'])), { document, location: { href: 'https://linux.do/latest' }, URL, Event });
  assert.equal(result.speedPercent, 20); assert.equal(started, 1);
  assert.deepEqual(events, ['input', 'change']);
});
