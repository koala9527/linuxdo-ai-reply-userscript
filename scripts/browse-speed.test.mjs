import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness } from './test-support.mjs';

const source = process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js', import.meta.url));
const harness = (saved) => createHarness(source, saved);
function running(speed = 10) {
  const h = harness();
  h.internals.saveBrowseConfig({ speedPercent: speed });
  h.internals.browseState.running = true;
  return h;
}
const link = (href, click = () => {}) => ({ href, getAttribute: () => href, click });
function article(id = '1') {
  return {
    isConnected: true, getAttribute: () => id,
    getBoundingClientRect: () => ({ top: 130 }),
    querySelector: (selector) => selector.includes('cooked') ? {
      cloneNode: () => ({ textContent: 'fixture', querySelectorAll: () => [] }),
    } : null,
  };
}

test('default speed is 10%, including migration from settings without speed', () => {
  assert.equal(harness().api.browseConfig().speedPercent, 10);
  assert.equal(harness({ 'ldya:browse:config': JSON.stringify({ targetTopics: 5 }) }).api.browseConfig().speedPercent, 10);
});
for (const [input, expected] of [[-1, 0], [0, 0], [10, 10], [100, 100], [101, 100], ['50', 50], ['bad', 10], ['', 10], [null, 10], [undefined, 10], [NaN, 10], [25.6, 26]]) {
  test(`speed normalization: ${String(input)} => ${expected}`, () => assert.equal(harness().internals.normalizeBrowseSpeed(input), expected));
}
test('speed persists through reload; zero is not converted to default', () => {
  const h = harness();
  h.api.setBrowseSpeed(0);
  assert.equal(harness(Object.fromEntries(h.values)).api.browseConfig().speedPercent, 0);
  h.api.setBrowseSpeed(37);
  assert.equal(harness(Object.fromEntries(h.values)).api.browseConfig().speedPercent, 37);
});
test('10 / percentage scaling: 10% baseline and 100% tenfold speed', () => {
  const h = harness();
  for (const speed of [1, 10, 50, 100]) {
    h.api.setBrowseSpeed(speed);
    for (const seconds of [0.8, 11, 18, 90]) assert.equal(h.internals.scaleBrowseDelay(seconds), seconds * 10 / speed);
  }
  h.api.setBrowseSpeed(0);
  assert.equal(h.internals.scaleBrowseDelay(18), Infinity);
});
test('legacy synthetic activity settings are discarded and base minimums are enforced', () => {
  const h = harness({ 'ldya:browse:config': JSON.stringify({ minPostDwellSeconds: -10, maxPostDwellSeconds: 1, cooldownSeconds: 0, enableMouseSim: true }) });
  assert.equal(h.api.browseConfig().minPostDwellSeconds, 6);
  assert.equal(h.api.browseConfig().maxPostDwellSeconds, 6);
  assert.equal(h.api.browseConfig().cooldownSeconds, 18);
  assert.equal('enableMouseSim' in h.api.browseConfig(), false);
});
test('UI slider specifies the full 0–100 range and default 10', () => {
  assert.match(harness().internals.renderBrowseTabHtml(), /data-bfield="speedPercent" type="range" min="0" max="100" step="1" value="10"/);
});
test('10% wait matches the baseline duration', async () => {
  const h = running(10);
  let done = false;
  const work = h.internals.waitBrowseDelay(1).then((ok) => { done = ok; });
  await h.advance(750); assert.equal(done, false);
  await h.advance(250); await work; assert.equal(done, true);
});
test('changing speed updates an in-progress wait without restarting it', async () => {
  const h = running(10);
  let done = false;
  const work = h.internals.waitBrowseDelay(2).then((ok) => { done = ok; });
  await h.advance(1000);
  h.api.setBrowseSpeed(100);
  await h.advance(200); assert.equal(done, false);
  await h.advance(250); await work; assert.equal(done, true);
});
test('speed zero freezes work, switching to nonzero resumes speed pause', async () => {
  const h = running(10);
  h.internals.autoBrowse.step = () => Promise.resolve();
  let done = false;
  const work = h.internals.waitBrowseDelay(2).then((ok) => { done = ok; });
  await h.advance(500); h.api.setBrowseSpeed(0);
  await h.advance(10000);
  assert.equal(done, false); assert.equal(h.api.browseState.pauseReason, 'speed');
  h.api.setBrowseSpeed(10);
  await h.advance(1500); await work; assert.equal(done, true);
});
test('manual pause is not undone by changing speed', async () => {
  const h = running(100);
  h.internals.autoBrowse.step = () => Promise.resolve();
  h.api.pauseBrowse(); h.api.setBrowseSpeed(50);
  assert.equal(h.api.browseState.pauseReason, 'manual');
  await h.advance(10000); assert.equal(h.api.browseState.completedPosts, 0);
  h.api.pauseBrowse(); assert.equal(h.api.browseState.paused, false);
});
test('stop resolves cancelled work and leaves no pending timers', async () => {
  const h = running(10);
  const work = h.internals.waitBrowseDelay(90);
  await h.advance(1000); h.api.stopBrowse(); await h.advance(250);
  assert.equal(await work, false); assert.equal(h.timerCount(), 0);
});
test('hidden page pauses until explicit manual resume', async () => {
  const h = running(100);
  h.internals.autoBrowse.step = () => Promise.resolve();
  const work = h.internals.waitBrowseDelay(1);
  h.document.hidden = true; await h.advance(500);
  assert.equal(h.api.browseState.pauseReason, 'hidden');
  h.document.hidden = false; await h.advance(5000);
  assert.equal(h.api.browseState.paused, true);
  h.api.stopBrowse(); await h.advance(250); assert.equal(await work, false);
});
for (const status of [403, 429]) {
  test(`observed HTTP ${status} suspends browsing; speed change does not resume it`, () => {
    const h = running(100);
    h.internals.riskDetector.recordTiming(status, 20);
    assert.equal(h.api.browseState.pauseReason, 'limit');
    h.api.setBrowseSpeed(50); assert.equal(h.api.browseState.paused, true);
  });
}
test('challenge element pauses movement and never solves verification', async () => {
  const h = running(100);
  h.document.querySelectorAll = () => [{ getBoundingClientRect: () => ({ width: 300, height: 65 }), checkVisibility: () => true }];
  const work = h.internals.smoothBrowseScrollTo(500, 800);
  await h.advance(1000); assert.equal(h.window.scrollY, 0);
  assert.equal(h.api.browseState.pauseReason, 'challenge');
  h.api.stopBrowse(); await h.advance(20); assert.equal(await work, false);
});
test('smooth scrolling respects speed and zero pause', async () => {
  const h = running(1);
  const work = h.internals.smoothBrowseScrollTo(1000, 800);
  await h.advance(800); assert.ok(h.window.scrollY < 1000);
  h.api.setBrowseSpeed(0); const previous = h.window.scrollY;
  await h.advance(3000); assert.equal(h.window.scrollY, previous);
  h.api.stopBrowse(); await h.advance(20); assert.equal(await work, false);
});
for (const [speed, milliseconds] of [[10, 1500], [50, 300], [100, 150]]) {
  test(`asynchronous delay at ${speed}% takes ${milliseconds}ms for 1.5 baseline seconds`, async () => {
    const h = running(speed); let done = false;
    const work = h.internals.waitBrowseDelay(1.5).then((ok) => { done = ok; });
    await h.advance(milliseconds - 1); assert.equal(done, false);
    await h.advance(1); await work; assert.equal(done, true);
  });
}
for (const [speed, milliseconds] of [[10, 800], [100, 80]]) {
  test(`requestAnimationFrame scroll at ${speed}% uses ${milliseconds}ms baseline scaling`, async () => {
    const h = running(speed); let done = false;
    const work = h.internals.smoothBrowseScrollTo(1000, 800).then((ok) => { done = ok; });
    await h.advance(milliseconds - 16); assert.equal(done, false);
    await h.advance(16); await work; assert.equal(done, true);
    assert.equal(h.window.scrollY, 1000);
  });
}
test('100% playback yields to unrelated input callbacks and caps HUD refresh frequency', async () => {
  const h = running(100); let callbacks = 0;
  h.renderTimes.length = 0;
  const work = h.internals.waitBrowseDelay(10);
  h.scheduleInput(100, () => { callbacks++; });
  h.scheduleInput(500, () => { callbacks++; });
  await h.advance(100); assert.equal(callbacks, 1);
  await h.advance(400); assert.equal(callbacks, 2);
  await h.advance(500); assert.equal(await work, true);
  const rendered = h.renderTimes.filter((entry) => entry.name === 'hud');
  assert.ok(rendered.length <= 4);
  for (let i = 1; i < rendered.length; i++) assert.ok(rendered[i].at - rendered[i - 1].at >= 250);
});
test('list discovery and navigation both respect 10% speed', async () => {
  const h = running(10);
  let clicks = 0;
  h.document.querySelectorAll = (selector) => selector.includes('.cf-turnstile') ? [] : [link('/t/fixture/123', () => clicks++)];
  const work = h.internals.autoBrowse.findAndEnterNextTopic();
  await h.advance(2250); assert.equal(clicks, 0);
  await h.advance(250); await work; assert.equal(clicks, 1);
});
test('speed-zero task does not navigate or increment counters', async () => {
  const h = harness(); let clicks = 0;
  h.document.querySelectorAll = (selector) => selector.includes('.cf-turnstile') ? [] : [link('/t/fixture/123', () => clicks++)];
  h.api.setBrowseSpeed(0); await h.api.startBrowse(); await h.advance(100000);
  assert.equal(clicks, 0); assert.equal(h.api.browseState.completedTopics, 0);
  assert.equal(h.api.browseState.completedPosts, 0);
});
test('empty list ends instead of reloading indefinitely', async () => {
  const h = harness(); h.api.setBrowseSpeed(100);
  const work = h.api.startBrowse(); await h.advance(1500); await work;
  assert.equal(h.api.browseState.running, false); assert.equal(h.location.href, 'https://linux.do/latest');
});
test('only same-origin HTTPS topic links are navigable', () => {
  const h = harness();
  for (const href of ['javascript:alert(1)', 'https://linux.do.evil.test/t/123', 'https://evil.test/t/123', 'http://linux.do/t/123']) assert.equal(h.internals.topicLink(link(href)), null);
  assert.equal(h.internals.topicLink(link('/t/fixture/123')).topicId, '123');
});
test('topic cooldown is scaled before selecting the next topic', async () => {
  const h = running(10); h.api.browseState.completedTopics = 1;
  const work = h.internals.autoBrowse.handleTopicFinished();
  await h.advance(17750); assert.equal(h.location.href, 'https://linux.do/latest');
  await h.advance(250); await work; assert.equal(h.location.href, '/latest');
});
test('periodic rest is also scaled at default 10%', async () => {
  const h = running(10); h.api.browseState.completedTopics = 5;
  const work = h.internals.autoBrowse.handleTopicFinished();
  await h.advance(89750); assert.equal(h.location.href, 'https://linux.do/latest');
  await h.advance(250); await work; assert.equal(h.location.href, '/latest');
});
test('route change invalidates old page work before navigation or counters can advance', async () => {
  const h = running(10);
  const work = h.internals.waitBrowseDelay(1);
  await h.advance(500); h.internals.autoBrowse.onRouteChange();
  await h.advance(250); assert.equal(await work, false);
  assert.equal(h.api.browseState.completedPosts, 0);
});
test('pause/resume keeps a single reader and counts the post once', async () => {
  const h = harness(); h.api.setBrowseSpeed(10);
  h.location.pathname = '/t/fixture/123'; h.location.href = 'https://linux.do/t/fixture/123';
  h.document.querySelectorAll = (selector) => selector === 'article[data-post-id]' ? [article()] : [];
  h.internals.saveBrowseConfig({ maxPostsPerTopic: 1, targetTopics: 1 });
  const work = h.api.startBrowse(); await h.advance(1000);
  h.api.pauseBrowse(); const reader = h.internals.autoBrowse.step();
  await h.advance(5000); assert.equal(h.api.browseState.completedPosts, 0);
  h.api.pauseBrowse(); const resumed = h.internals.autoBrowse.step();
  assert.equal(resumed, work); assert.notEqual(reader, work);
  await h.advance(12000); await work;
  assert.equal(h.api.browseState.completedTopics, 1); assert.equal(h.api.browseState.completedPosts, 1);
});
test('stop prevents late post counts after the reading delay', async () => {
  const h = harness(); h.api.setBrowseSpeed(10);
  h.location.pathname = '/t/fixture/123';
  h.document.querySelectorAll = (selector) => selector === 'article[data-post-id]' ? [article()] : [];
  const work = h.api.startBrowse(); await h.advance(1000);
  h.api.stopBrowse(); await h.advance(30000); await work;
  assert.equal(h.api.browseState.completedPosts, 0);
});
test('persisted same-tab progress avoids counting the same topic again', async () => {
  const h = harness(); h.api.setBrowseSpeed(100);
  Object.assign(h.api.browseState, { running: true, paused: true, pauseReason: 'manual', currentTopicId: '123', completedTopics: 1, completedPosts: 1, currentTopicPostsRead: 1, readPostKeys: ['1'] });
  h.internals.persistBrowseState();
  const restored = harness(Object.fromEntries(h.values)); restored.internals.loadBrowseState();
  assert.equal(restored.api.browseState.currentTopicId, '123'); assert.equal(restored.api.browseState.completedPosts, 1);
  assert.equal(restored.api.browseState.paused, true);
  const otherTab = Object.fromEntries([...h.values].filter(([key]) => !key.startsWith('session:')));
  const fresh = harness(otherTab); fresh.internals.loadBrowseState(); assert.equal(fresh.api.browseState.running, false);
});
test('new run cancels old run without cancelling the new reader', async () => {
  const h = running(100);
  const old = h.internals.waitBrowseDelay(90);
  h.api.stopBrowse(); h.api.setBrowseSpeed(0); await h.api.startBrowse();
  await h.advance(250); assert.equal(await old, false); assert.equal(h.api.browseState.running, true);
});
