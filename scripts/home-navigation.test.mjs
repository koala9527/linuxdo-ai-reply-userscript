import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness } from './test-support.mjs';
const src=process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js',import.meta.url));
async function simulate({hiddenBeforeUnload=false,arrivalHidden=false,reason='',reasonAfterUnload='',path='/latest',age=2000,challenge=false,zeroSpeed=false,kind='topic'}={}) {
 const h=createHarness(src); h.api.setBrowseSpeed(100);
 Object.assign(h.api.browseState,{running:true,paused:false,completedTopics:3,completedPosts:9});
 h.location.pathname=kind==='topic' ? '/t/test/123' : '/latest'; h.location.href='https://linux.do'+h.location.pathname;
 h.internals.riskDetector.hookNetwork=()=>{}; h.internals.riskDetector.init();
 const work=kind==='topic' ? h.internals.autoBrowse.handleTopicFinished() : h.internals.autoBrowse.findAndEnterNextTopic();
 await h.advance(kind==='topic' ? 1800 : 300150); await work;
 if(reason) h.internals.autoBrowse.suspend(reason,'fixture');
 if(hiddenBeforeUnload) { h.document.hidden=true; h.document.visibilityState='hidden'; h.listeners.get('visibilitychange')(); }
 h.windowListeners.get('pagehide')?.();
 if(reasonAfterUnload) h.internals.autoBrowse.suspend(reasonAfterUnload,'fixture');
 if(!hiddenBeforeUnload) { h.document.hidden=true; h.document.visibilityState='hidden'; h.listeners.get('visibilitychange')(); }
 const next=createHarness(src,Object.fromEntries(h.values)); await next.advance(age); next.location.pathname=path; next.document.hidden=arrivalHidden; next.document.visibilityState=arrivalHidden?'hidden':'visible';
 if(zeroSpeed) next.api.setBrowseSpeed(0);
 if(challenge) next.document.querySelectorAll=()=>[{getBoundingClientRect:()=>({width:300,height:65}),checkVisibility:()=>true}];
 next.internals.loadBrowseState(); return {next,saved:JSON.parse(h.values.get('session:ldya:browse:state'))};
}
test('foreground home navigation resumes progress after unload visibility change',async()=>{
 const {next}=await simulate(); assert.equal(next.api.browseState.paused,false); assert.equal(next.api.browseState.completedTopics,3); assert.equal(next.api.browseState.completedPosts,9);
});
test('scheduled latest-page refresh also resumes after foreground unload',async()=>{
 const {next}=await simulate({kind:'refresh',age:300300}); assert.equal(next.api.browseState.paused,false);
});
for(const [name,opts] of [['background before unload',{hiddenBeforeUnload:true}],['arrival in background',{arrivalHidden:true}],['manual pause',{reason:'manual'}],['rate limit',{reason:'limit'}],['unexpected destination',{path:'/new'}],['expired transition',{age:20000}],['visible challenge',{challenge:true}],['zero speed',{zeroSpeed:true}]]) {
 test(`${name} remains paused`,async()=>{const {next}=await simulate(opts); assert.equal(next.api.browseState.paused,true);});
}
test('a background visibility event does not overwrite a manual or rate-limit pause',async()=>{
 for(const reason of ['manual','limit']) {const {next}=await simulate({reason}); assert.equal(next.api.browseState.pauseReason,reason);}
});
test('rate-limit received after navigation begins still requires manual recovery',async()=>{
 const {next}=await simulate({reasonAfterUnload:'limit'}); assert.equal(next.api.browseState.paused,true); assert.equal(next.api.browseState.pauseReason,'limit');
});
test('navigation authorization is consumed so a later background pause stays paused',async()=>{
 const {next}=await simulate(); next.internals.autoBrowse.suspend('hidden','fixture');
 const after=createHarness(src,Object.fromEntries(next.values)); await after.advance(2500); after.internals.loadBrowseState();
 assert.equal(after.api.browseState.paused,true); assert.equal(after.api.browseState.pauseReason,'hidden');
});