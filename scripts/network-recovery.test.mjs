import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness } from './test-support.mjs';
const src = process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js', import.meta.url));
function running(saved = {}) {
  const h = createHarness(src, saved);
  h.api.setBrowseSpeed(100);
  Object.assign(h.api.browseState, { running: true, completedTopics: 3, completedPosts: 9 });
  h.reloads = 0;
  h.location.reload = () => h.reloads++;
  h.internals.riskDetector.hookNetwork = () => {};
  h.internals.riskDetector.init();
  return h;
}
async function afterReload(h) {
  h.windowListeners.get('pagehide')?.();
  h.document.hidden = true;
  h.listeners.get('visibilitychange')();
  const next = running(Object.fromEntries(h.values));
  const saved = JSON.parse(h.values.get('session:ldya:browse:state'));
  await next.advance((saved.networkReloadAt || 0) + 1000);
  next.internals.loadBrowseState();
  return next;
}

test('403 refreshes after 15 then 45 real seconds, keeping progress and stopping at two attempts', async () => {
  let h = running();
  for (const delay of [15000, 45000]) {
    h.internals.riskDetector.recordTiming(403, 20);
    assert.equal(h.api.browseState.pauseReason, 'network');
    await h.advance(delay - 1); assert.equal(h.reloads, 0);
    await h.advance(1); assert.equal(h.reloads, 1);
    h = await afterReload(h);
    assert.equal(h.api.browseState.paused, false);
    assert.equal(h.api.browseState.completedTopics, 3);
    assert.equal(h.api.browseState.completedPosts, 9);
  }
  h.internals.riskDetector.recordTiming(403, 20);
  await h.advance(120000);
  assert.equal(h.reloads, 0);
  assert.equal(h.api.browseState.pauseReason, 'limit');
});

test('concurrent errors share one pending retry and do not spend the next attempt', async () => {
  const h = running();
  for (let i = 0; i < 10; i++) h.internals.riskDetector.recordTiming(403, 10);
  await h.advance(15000);
  assert.equal(h.reloads, 1);
  assert.equal(h.api.browseState.networkRetries, 1);
});

for (const [name, interrupt] of [
  ['manual pause', h => h.internals.autoBrowse.suspend('manual', 'manual')],
  ['background', h => { h.document.hidden = true; h.listeners.get('visibilitychange')(); }],
  ['zero speed', h => h.api.setBrowseSpeed(0)],
  ['stop', h => h.api.stopBrowse()],
  ['429', h => h.internals.riskDetector.recordTiming(429, 10)],
  ['challenge', h => { h.document.querySelectorAll = () => [{ getBoundingClientRect: () => ({ width: 10, height: 10 }), checkVisibility: () => true }]; }],
]) {
  test(`${name} cancels a pending refresh`, async () => {
    const h = running(); h.internals.riskDetector.recordTiming(403, 10);
    await h.advance(1000); interrupt(h); await h.advance(60000);
    assert.equal(h.reloads, 0);
  });
}

test('an existing manual pause is not replaced by a later 403', async () => {
  const h = running(); h.internals.autoBrowse.suspend('manual', 'manual');
  h.internals.riskDetector.recordTiming(403, 10); await h.advance(60000);
  assert.equal(h.api.browseState.pauseReason, 'manual'); assert.equal(h.reloads, 0);
});

test('a challenge response header disables 403 retries', async () => {
  const h = running(); h.internals.riskDetector.recordTiming(403, 10, true);
  await h.advance(60000); assert.equal(h.reloads, 0);
  assert.equal(h.api.browseState.pauseReason, 'challenge');
});

test('network failure and server errors use bounded recovery', async () => {
  for (const status of [0, 408, 502, 503, 504]) {
    const h = running(); h.internals.riskDetector.recordTiming(status, 10);
    await h.advance(15000); assert.equal(h.reloads, 1, String(status));
  }
});

test('reload authorization does not resume on an unexpected page or in the background', async () => {
  for (const background of [false, true]) {
    const h = running(); h.internals.riskDetector.recordTiming(403, 10); await h.advance(15000);
    h.windowListeners.get('pagehide')?.();
    const next = running(Object.fromEntries(h.values));
    if (background) next.document.hidden = true; else next.location.pathname = '/new';
    next.internals.loadBrowseState(); assert.equal(next.api.browseState.paused, true);
  }
});

test('request classification only observes same-origin browsing endpoints', () => {
  const { riskDetector } = running().internals;
  for (const url of ['/latest.json?page=2', '/t/test/123.json', '/t/123/posts.json']) assert.equal(riskDetector.requestKind(url), 'content');
  assert.equal(riskDetector.requestKind('/topics/timings'), 'timing');
  for (const url of ['https://example.com/topics/timings', '/posts.json', '/session', '/x/topics/timings']) assert.equal(riskDetector.requestKind(url), '');
});

test('fetch hooks observe list failures, ignore aborted requests and preserve the original promise', async () => {
  const h = createHarness(src); h.api.browseState.running = true;
  const failure = Promise.resolve({ status: 403, headers: { get: () => null } });
  h.window.fetch = () => failure;
  h.internals.riskDetector.hookNetwork();
  assert.equal(h.window.fetch(new URL('https://linux.do/latest.json')), failure);
  await h.advance(1); assert.equal(h.api.browseState.pauseReason, 'network');
  h.api.stopBrowse();
  const second = createHarness(src); second.api.browseState.running = true;
  second.window.fetch = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  second.internals.riskDetector.hookNetwork();
  await assert.rejects(second.window.fetch('/latest.json')); await second.advance(1);
  assert.equal(second.api.browseState.paused, false);
});

test('reused XHR objects report once per response and abort does not trigger retry', () => {
  class XHR extends EventTarget {
    open() {} send() {} getResponseHeader() { return null; }
    finish(event, status) { this.status = status; this.dispatchEvent(new Event(event)); this.dispatchEvent(new Event('loadend')); }
  }
  const h = createHarness(src, {}, { XMLHttpRequest: XHR });
  h.internals.riskDetector.hookNetwork();
  const observed = []; h.internals.riskDetector.recordResponse = (...args) => observed.push(args);
  const xhr = new XHR();
  for (let i = 0; i < 4; i++) { xhr.open('GET', '/latest.json'); xhr.send(); xhr.finish('load', 200); }
  xhr.open('GET', '/latest.json'); xhr.send(); xhr.finish('abort', 0);
  xhr.open('GET', '/latest.json'); xhr.send(); xhr.finish('error', 0);
  assert.equal(observed.length, 5); assert.equal(observed.at(-1)[1], 0);
});

test('document 403 invokes recovery before the browse step', async () => {
  const h = createHarness(src, {}, { performance: { now: () => 0, getEntriesByType: () => [{ responseStatus: 403 }] } });
  h.api.browseState.running = true; let steps = 0; h.internals.autoBrowse.step = () => steps++;
  h.internals.autoBrowse.onPageLoad(); assert.equal(h.api.browseState.pauseReason, 'network'); assert.equal(steps, 0);
  h.api.stopBrowse();
});

test('SPA navigation cancels a pending reload of the previous page', async () => {
  const h = running(); h.internals.riskDetector.recordTiming(403, 10);
  h.internals.autoBrowse.onRouteChange(); await h.advance(60000); assert.equal(h.reloads, 0);
});
