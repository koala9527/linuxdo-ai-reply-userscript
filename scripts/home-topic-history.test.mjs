import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness } from './test-support.mjs';
const src = process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js', import.meta.url));
const make = () => createHarness(src);
const topic = (id, click = () => {}) => ({ href: `/t/test/${id}`, getAttribute: () => `/t/test/${id}`, click });
function running() { const h=make(); h.api.setBrowseSpeed(100); h.api.browseState.running=true; h.api.browseState.completedTopics=1; return h; }
test('finishing a topic returns to latest rather than clicking suggested topics', async () => {
 const h=running(); let clicks=0; h.location.pathname='/t/test/111'; h.location.href='https://linux.do/t/test/111';
 h.document.querySelectorAll = s => s.includes('suggested-topics') ? [topic('222', () => clicks++)] : [];
 const work=h.internals.autoBrowse.handleTopicFinished(); await h.advance(1800); await work;
 assert.equal(clicks,0); assert.equal(h.location.href,'/latest');
});
test('list skips visited topics and records the clicked topic before navigation', async () => {
 const h=running(); h.api.browseState.history.push('111'); let clicked=''; let historyAtClick=[];
 h.document.querySelectorAll = s => s.includes('.topic-list-item') ? [topic('111',()=>clicked='111'), topic('222',()=>{clicked='222'; historyAtClick=JSON.parse(h.values.get('ldya:browse:history'));})] : [];
 const work=h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(250); await work;
 assert.equal(clicked,'222'); assert.deepEqual(historyAtClick,['111','222']);
 const next=createHarness(src,Object.fromEntries(h.values)); assert.deepEqual(Array.from(next.api.browseState.history),['111','222']);
});
test('history retains more than 300 visited topics after reload', () => {
 const h=make(); h.api.browseState.history.push(...Array.from({length:350},(_,i)=>String(i+1))); h.internals.persistBrowseState();
 const next=createHarness(src,Object.fromEntries(h.values)); assert.equal(next.api.browseState.history.length,350); assert.equal(next.api.browseState.history[0],'1');
});
test('all visited topics ends without clicking or refreshing', async () => {
 const h=running(); h.api.browseState.history.push('111'); let clicks=0;
 h.document.querySelectorAll=s=>s.includes('.topic-list-item') ? [topic('111',()=>clicks++)] : [];
 const work=h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(150); await work;
 assert.equal(clicks,0); assert.equal(h.api.browseState.running,false); assert.equal(h.location.href,'https://linux.do/latest');
});
test('a topic recorded during the selection wait is skipped before the click', async () => {
 const h=running(); let clicked='';
 h.document.querySelectorAll=s=>s.includes('.topic-list-item') ? [topic('111',()=>clicked='111'),topic('222',()=>clicked='222')] : [];
 h.scheduleInput(200,()=>h.api.browseState.history.push('111'));
 const work=h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(500); await work;
 assert.equal(clicked,'222'); assert.deepEqual(Array.from(h.api.browseState.history),['111','222']);
});
test('going to the background before clicking keeps the task paused and does not record a click', async () => {
 const h=running(); let clicks=0;
 h.document.querySelectorAll=s=>s.includes('.topic-list-item') ? [topic('111',()=>clicks++)] : [];
 h.scheduleInput(200,()=>{h.document.hidden=true;});
 const work=h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(500);
 assert.equal(clicks,0); assert.equal(h.api.browseState.pauseReason,'hidden'); assert.equal(h.api.browseState.history.length,0);
 h.api.stopBrowse(); await h.advance(250); await work;
});