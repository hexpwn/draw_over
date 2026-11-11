/* Anchoring on sites that scroll an inner element instead of the document
 * (window.scrollY stays 0 there, so the naive offset never moves). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, newPage } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'content.js'), 'utf8');
const STUB = `window.chrome={storage:{local:{get(k,cb){cb&&cb({})},set(){},remove(){}}},runtime:{sendMessage(){},onMessage:{addListener(){}},lastError:null}};`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${n}${ok || !extra ? '' : '   -> ' + extra}`); };

const browser = await launch({ headless: true, port: 9700 + (process.pid % 250) });
const page = await newPage(browser.port, 'file://' + join(here, 'scroll-page.html'));
await page.send('Runtime.enable');
const ev = async (e) => {
  const r = await page.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const mouse = (t, x, y, bt = 1) => page.send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', buttons: bt, clickCount: 1, pointerType: 'mouse' });
async function drag(x1, y1, x2, y2) {
  await mouse('mousePressed', x1, y1);
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x1 + (x2 - x1) * i / 5, y1 + (y2 - y1) * i / 5);
  await mouse('mouseReleased', x2, y2, 0);
}
const wheel = (x, y, dy) => page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse' });

/* Measure each shape by its own id — DOM order groups by layer, which does not
 * match the order the shapes were drawn in. */
const probe = `(()=>{const sr=document.querySelector('draw-over-9f3a2c').shadowRoot;
  return { winY: window.scrollY, innerY: document.getElementById('scroller').scrollTop,
    tops: window.__drawOver__.state.shapes.map(s=>{
      const g=sr.querySelector('[data-id="'+s.id+'"]');
      return g ? Math.round(g.getBoundingClientRect().top) : null; }) };})()`;

await sleep(500);
await ev(STUB); await ev(SRC); await sleep(200);
await ev(`window.__drawOver__.handle('toggle-overlay')`);

await drag(300, 300, 600, 360);                       // page-anchored
await ev(`window.__drawOver__.state.space='screen'; window.__drawOver__.state.tool='rect'; window.__drawOver__.state.selected=null;`);
await drag(300, 450, 600, 510);                       // screen-anchored

let s = await ev(probe);
check('both boxes drawn where expected', s.tops[0] === 300 && s.tops[1] === 450, JSON.stringify(s));
check('this page really does not scroll the document', s.winY === 0);

await wheel(640, 400, 200);
await sleep(400);
s = await ev(probe);
check('wheel over the overlay scrolls the inner container', s.innerY === 200, JSON.stringify(s));
check('page-anchored box follows the inner scroll', s.tops[0] === 100, JSON.stringify(s));
check('screen-anchored box stays put', s.tops[1] === 450, JSON.stringify(s));

await wheel(640, 400, -200);
await sleep(400);
s = await ev(probe);
check('scrolling back restores the original position', s.innerY === 0 && s.tops[0] === 300, JSON.stringify(s));

/* Drawing while scrolled must store document-space coords, not viewport ones. */
await wheel(640, 400, 300);
await sleep(400);
await ev(`window.__drawOver__.state.space='page'; window.__drawOver__.state.tool='rect'; window.__drawOver__.state.selected=null;`);
await drag(300, 200, 600, 260);
await wheel(640, 400, -300);
await sleep(400);
s = await ev(probe);
check('a box drawn while scrolled stays with its content', s.tops[2] === 500, JSON.stringify(s));

console.log(`\n${pass} passed, ${fail} failed`);
page.close(); browser.proc.kill();
process.exit(fail ? 1 : 0);
