/* Loads the built Chrome extension into real Chromium and exercises the
 * toolbar-button path: background service worker -> content script. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, newPage, attach, targets } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${n}${ok || !extra ? '' : '   -> ' + extra}`); };

const ext = join(here, '..', 'dist', 'chrome');
const browser = await launch({ headless: true, port: 9400 + (process.pid % 400), extension: ext });
await sleep(1500);

const page = await newPage(browser.port, 'file://' + join(here, 'page.html'));
await page.send('Runtime.enable');
const ev = async (e) => (await page.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
await sleep(1200);

const list = await targets(browser.port);
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
check('background service worker registered', !!sw, list.map((t) => t.type + ':' + t.url.slice(0, 60)).join('\n'));

check('an unused page is left completely untouched', await ev(`!document.querySelector('draw-over-9f3a2c')`));

if (sw) {
  const worker = await attach(sw.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');
  const wev = async (e) => {
    const r = await worker.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  check('worker exposes the command dispatcher', await wev('typeof dispatch === "function" && typeof activeTab === "function"'));

  /* A ping only answers if the declarative content script already registered. */
  check('content script is present without an explicit inject',
    await wev(`(async()=>{ try { await send((await activeTab()).id, 'ping'); return true; } catch (e) { return false; } })()`));

  /* This is exactly what clicking the toolbar button runs. */
  await wev(`(async()=>{ await dispatch(await activeTab(), "toggle-overlay"); return 1; })()`);
  await sleep(500);
  check('toolbar-button path turns the overlay on', await ev(`document.querySelector('draw-over-9f3a2c').hidden === false`));
  check('toolbar is visible on the page',
    await ev(`(()=>{const t=document.querySelector('draw-over-9f3a2c').shadowRoot.querySelector('.tb');
      return !!t && t.getBoundingClientRect().width > 200;})()`));

  /* Keyboard-command path. */
  await wev(`(async()=>{ await dispatch(await activeTab(), "toggle-passthrough"); return 1; })()`);
  await sleep(400);
  check('toggle-passthrough reaches the content script',
    await ev(`getComputedStyle(document.querySelector('draw-over-9f3a2c').shadowRoot.querySelector('svg')).pointerEvents === 'none'`));

  await wev(`(async()=>{ await dispatch(await activeTab(), "toggle-overlay"); return 1; })()`);
  await sleep(400);
  check('a second toggle-overlay resumes drawing rather than hiding',
    await ev(`getComputedStyle(document.querySelector('draw-over-9f3a2c').shadowRoot.querySelector('svg')).pointerEvents === 'auto'`));

  await wev(`(async()=>{ await dispatch(await activeTab(), "toggle-overlay"); return 1; })()`);
  await sleep(400);
  check('a third toggle-overlay turns it off', await ev(`document.querySelector('draw-over-9f3a2c').hidden === true`));

  /* Injection fallback for tabs that predate the extension. */
  check('inject() fallback is wired', await wev('typeof inject === "function"'));
  worker.close();
}

/* Only extension/manifest complaints matter here; Chromium's GPU, socket and
 * GCM chatter is unrelated background noise in a sandbox. */
const errs = browser.stderr().split('\n').filter((l) =>
  /extension|manifest|Unrecognized|content_script|service.worker/i.test(l) && /ERROR|WARNING|Invalid|Failed/i.test(l));
check('chromium reported no extension or manifest errors', errs.length === 0, errs.join('\n'));

console.log(`\n${pass} passed, ${fail} failed`);
page.close();
browser.proc.kill();
process.exit(fail ? 1 : 0);
