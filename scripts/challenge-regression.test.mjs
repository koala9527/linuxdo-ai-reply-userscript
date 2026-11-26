import { createHarness } from './test-support.mjs';
import { fileURLToPath } from 'node:url';
const h = createHarness(process.env.LDYA_TEST_SOURCE || fileURLToPath(new URL('../linuxdo-ai-reply.user.js', import.meta.url)));
const selector = '.cf-turnstile, #challenge-stage, #cf-wrapper, iframe[src*="challenges.cloudflare.com"]';
function element(width,height,visible=true) { return { getBoundingClientRect: () => ({ width,height }), checkVisibility: () => visible }; }
let failures=0;
for (const [name,elements,expected] of [
  ['zero-height Turnstile', [element(1692,0)], false],
  ['visible challenge', [element(300,65)], true],
  ['hidden challenge', [element(300,65,false)], false],
  ['zero-height then visible', [element(1692,0),element(300,65)], true],
  ['no challenge', [], false],
]) {
  h.document.querySelector = s => s === selector ? (elements[0] || null) : null;
  h.document.querySelectorAll = s => s === selector ? elements : [];
  const report=h.internals.riskDetector.getReport();
  const actual=report.challengeDetected;
  const ok=actual === expected && (actual ? report.safetySummary === '检测到 Cloudflare 人机挑战' : report.safetySummary !== '检测到 Cloudflare 人机挑战');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: challengeDetected=${actual}, summary=${actual ? 'warning' : 'other'}`);
  if (!ok) failures++;
}
process.exitCode = failures ? 1 : 0;
