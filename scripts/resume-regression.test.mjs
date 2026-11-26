import { createHarness } from './test-support.mjs';
import { fileURLToPath } from 'node:url';
const src = process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js', import.meta.url)); let failures=0;
function run(name, {speed=35,hidden=false,elements=[], expectedPaused, expectedToast}) {
  const h=createHarness(src); h.window.__testToasts=[];
  const selector='.cf-turnstile, #challenge-stage, #cf-wrapper, iframe[src*="challenges.cloudflare.com"]';
  h.document.querySelector=s=>s===selector ? elements[0] || null : null;
  h.document.querySelectorAll=s=>s===selector ? elements : [];
  h.document.hidden=hidden; h.api.setBrowseSpeed(speed);
  h.internals.browseState.running=true; h.internals.browseState.paused=true; h.internals.browseState.pauseReason='manual';
  h.internals.autoBrowse.step=()=>Promise.resolve(); h.api.pauseBrowse();
  const paused=h.api.browseState.paused; const toast=h.window.__testToasts.at(-1) || '';
  const ok=paused===expectedPaused && (!expectedToast || toast===expectedToast);
  console.log(`${ok?'PASS':'FAIL'} ${name}: paused=${paused}, toastCode=${toast===expectedToast?'expected':toast?'other':'none'}`); if(!ok) failures++;
}
const el=(w,h,visible=true)=>({getBoundingClientRect:()=>({width:w,height:h}),checkVisibility:()=>visible});
run('35 percent with zero-height turnstile', {elements:[el(1692,0)], expectedPaused:false});
run('zero speed', {speed:0,expectedPaused:true,expectedToast:'浏览速度为 0%，请先设置非零速度'});
run('hidden page', {hidden:true,expectedPaused:true,expectedToast:'当前页面已隐藏，请切回页面后恢复'});
run('visible challenge', {elements:[el(300,65)],expectedPaused:true,expectedToast:'检测到可见验证，请先手动处理后恢复'});
process.exitCode=failures?1:0;