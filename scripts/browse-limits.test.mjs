import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness } from './test-support.mjs';
const src=process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js',import.meta.url));
const fields=['targetTopics','targetPosts','maxPostsPerTopic','minPostDwellSeconds','maxPostDwellSeconds','cooldownSeconds'];
test('numeric settings retain five-digit values after save and reload',()=>{
 const h=createHarness(src); const values=Object.fromEntries(fields.map(field=>[field,54321])); h.internals.saveBrowseConfig(values);
 for(const field of fields) assert.equal(h.api.browseConfig()[field],54321,field);
 const next=createHarness(src,Object.fromEntries(h.values)); for(const field of fields) assert.equal(next.api.browseConfig()[field],54321,field);
});
test('numeric settings cap at 99999 and preserve minimum constraints',()=>{
 const h=createHarness(src); h.internals.saveBrowseConfig(Object.fromEntries(fields.map(field=>[field,100000])));
 for(const field of fields) assert.equal(h.api.browseConfig()[field],99999,field);
 h.internals.saveBrowseConfig({targetTopics:0,targetPosts:-1,maxPostsPerTopic:0,minPostDwellSeconds:0,maxPostDwellSeconds:0,cooldownSeconds:0});
 assert.equal(h.api.browseConfig().targetTopics,1); assert.equal(h.api.browseConfig().targetPosts,1); assert.equal(h.api.browseConfig().maxPostsPerTopic,1);
 assert.equal(h.api.browseConfig().minPostDwellSeconds,6); assert.equal(h.api.browseConfig().maxPostDwellSeconds,6); assert.equal(h.api.browseConfig().cooldownSeconds,18);
});
test('all numeric inputs allow 99999 while speed remains 0–100',()=>{
 const html=createHarness(src).internals.renderBrowseTabHtml();
 for(const field of fields) assert.match(html,new RegExp(`data-bfield="${field}" type="number"[^>]*max="99999"`),field);
 assert.match(html,/data-bfield="speedPercent" type="range" min="0" max="100"/);
});
test('a five-digit target continues beyond old 100-topic and 300-post limits',async()=>{
 const h=createHarness(src); h.internals.saveBrowseConfig({targetTopics:50000,targetPosts:60000});
 Object.assign(h.api.browseState,{running:true,paused:false,completedTopics:100,completedPosts:300});
 let next=0; h.internals.autoBrowse.findAndEnterNextTopic=async()=>{next++;}; await h.internals.autoBrowse.step();
 assert.equal(h.api.browseState.running,true); assert.equal(next,1);
});
test('an exhausted latest list waits five real minutes before checking again',async()=>{
 const h=createHarness(src); h.api.setBrowseSpeed(100); h.api.browseState.running=true; h.document.querySelectorAll=()=>[];
 const work=h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(150);
 assert.equal(h.api.browseState.running,true); assert.equal(h.location.href,'https://linux.do/latest');
 await h.advance(299999); assert.equal(h.location.href,'https://linux.do/latest');
 await h.advance(1); await work; assert.equal(h.location.href,'/latest');
});
test('waiting for new topics pauses in the background and does not refresh',async()=>{
 const h=createHarness(src); h.api.setBrowseSpeed(100); h.api.browseState.running=true; h.document.querySelectorAll=()=>[];
 const work=h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(150); h.document.hidden=true; await h.advance(301000);
 assert.equal(h.api.browseState.pauseReason,'hidden'); assert.equal(h.location.href,'https://linux.do/latest');
 h.api.stopBrowse(); await h.advance(1000); await work;
});
test('HTTP 429 stops the long wait from refreshing until manually resumed',async()=>{
 const h=createHarness(src); h.api.setBrowseSpeed(100); h.api.browseState.running=true; h.document.querySelectorAll=()=>[];
 const work=h.internals.autoBrowse.findAndEnterNextTopic(); await h.advance(150); h.internals.riskDetector.recordTiming(429,10); await h.advance(301000);
 assert.equal(h.api.browseState.pauseReason,'limit'); assert.equal(h.location.href,'https://linux.do/latest');
 h.api.stopBrowse(); await h.advance(1000); await work;
});
test('five-digit progress and target survive a same-tab reload',async()=>{
 const h=createHarness(src); h.internals.saveBrowseConfig({targetTopics:99999,targetPosts:99999});
 Object.assign(h.api.browseState,{running:true,paused:false,completedTopics:54321,completedPosts:88888}); h.internals.persistBrowseState();
 const next=createHarness(src,Object.fromEntries(h.values)); next.internals.loadBrowseState(); let called=0; next.internals.autoBrowse.findAndEnterNextTopic=async()=>{called++;};
 await next.internals.autoBrowse.step(); assert.equal(next.api.browseState.completedTopics,54321); assert.equal(next.api.browseState.completedPosts,88888); assert.equal(called,1);
});