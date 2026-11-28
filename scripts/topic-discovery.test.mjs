import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness } from './test-support.mjs';
const src = process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js', import.meta.url));
function fixture() {
  const h = createHarness(src); h.api.setBrowseSpeed(100); h.api.browseState.running = true;
  h.ids = ['111']; h.clicked = []; h.api.browseState.history.push('111');
  h.document.querySelectorAll = selector => selector.includes('.topic-list-item') ? h.ids.map(id => ({
    href: `/t/test/${id}`, getAttribute: () => `/t/test/${id}`, isConnected: true,
    getBoundingClientRect: () => ({ top: 1200 - h.window.scrollY, bottom: 1250 - h.window.scrollY }),
    click: () => h.clicked.push(id),
  })) : [];
  h.document.querySelector = selector => selector.includes('.topic-list') ? { getBoundingClientRect: () => ({ bottom: 1300 - h.window.scrollY }) } : null;
  return h;
}
test('an exhausted first batch scrolls the list and opens an unvisited topic loaded later', async () => {
  const h = fixture(); h.scheduleInput(2000, () => { if (h.window.scrollY > 0) h.ids.push('222'); });
  const work = h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(12000);
  assert.deepEqual(h.clicked, ['222']); assert.deepEqual(Array.from(h.api.browseState.history), ['111', '222']);
  h.api.stopBrowse(); await h.advance(1000); await work;
});
test('discovery continues across several already-visited batches', async () => {
  const h = fixture(); h.api.browseState.history.push('222', '333');
  h.scheduleInput(2000, () => h.ids.push('222')); h.scheduleInput(5000, () => h.ids.push('333')); h.scheduleInput(8000, () => h.ids.push('444'));
  const work = h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(16000);
  assert.deepEqual(h.clicked, ['444']); h.api.stopBrowse(); await h.advance(1000); await work;
});
test('newly inserted topics interrupt the five-minute empty-list wait', async () => {
  const h = fixture(); const work = h.internals.autoBrowse.findAndEnterNextTopic();
  await h.advance(30000); assert.deepEqual(h.clicked, []); h.ids.push('222'); await h.advance(2000);
  assert.deepEqual(h.clicked, ['222']); h.api.stopBrowse(); await h.advance(1000); await work;
});
test('a list that loads nothing keeps the task alive without clicking visited topics', async () => {
  const h = fixture(); const work = h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(30000);
  assert.equal(h.api.browseState.running, true); assert.deepEqual(h.clicked, []); assert.equal(h.location.href, 'https://linux.do/latest');
  h.api.stopBrowse(); await h.advance(1000); await work;
});
