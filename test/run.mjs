/* End-to-end exercise of the content script in real Chromium via CDP. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, newPage } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'content.js'), 'utf8');
const OUT = process.env.SHOT_DIR || here;

let pass = 0, fail = 0;
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
function check(name, ok, extra = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !extra ? '' : '   -> ' + extra}`);
}

const STUB = `
window.chrome = {
  storage: { local: { get(k, cb) { cb && cb({}); }, set() {}, remove() {} } },
  runtime: { sendMessage() {}, onMessage: { addListener() {} }, lastError: null },
};`;

const browser = await launch({ headless: true, port: 9400 + (process.pid % 400) });
const page = await newPage(browser.port, 'file://' + join(here, 'page.html'));
await page.send('Page.enable');
await page.send('Runtime.enable');
const logs = [];
page.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(JSON.stringify(m.params.args));
  if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
});
await new Promise((r) => setTimeout(r, 600));

const evaluate = async (expression) => {
  const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

async function mouse(type, x, y, buttons = 1) {
  await page.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse',
  });
}
async function drag(x1, y1, x2, y2, steps = 6) {
  await mouse('mousePressed', x1, y1);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
  }
  await mouse('mouseReleased', x2, y2, 0);
}
async function key(k, code, vk) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
}
const S = () => evaluate('JSON.parse(JSON.stringify(window.__drawOver__.state))');

/* ---- boot ---- */
await evaluate(STUB);
await evaluate(SRC);
await new Promise((r) => setTimeout(r, 200));
check('content script boots without throwing', logs.length === 0, logs.join(' | '));
check('adds nothing to the page until it is actually used',
  await evaluate(`!document.querySelector('draw-over-9f3a2c')`));

/* ---- activate via the same path the toolbar button uses ---- */
await evaluate(`window.__drawOver__.handle('toggle-overlay')`);
let st = await S();
check('toggle-overlay activates', st.active && !st.passthrough);
check('overlay host appears on activation',
  await evaluate(`document.querySelector('draw-over-9f3a2c')?.hidden === false`));
check('toolbar is rendered', await evaluate(`!!document.querySelector('draw-over-9f3a2c').shadowRoot.querySelector('.tb')`));
check('default tool is rectangle', st.tool === 'rect');

/* ---- draw a blackout box over the subtitles ---- */
await drag(300, 620, 900, 690);
st = await S();
check('rectangle created', st.shapes.length === 1, JSON.stringify(st.shapes));
const r0 = st.shapes[0];
check('rectangle geometry matches the drag',
  near(r0.box.x, 300) && near(r0.box.y, 620) && near(r0.box.w, 600) && near(r0.box.h, 70), JSON.stringify(r0.box));
check('rectangle is a solid black fill by default', r0.fillMode === 'solid' && r0.color === '#000000');
check('drops into edit mode on the new shape', st.tool === 'select' && st.selected === r0.id);

/* ---- drag it ---- */
await drag(600, 655, 640, 675);
st = await S();
check('dragging the body moves the shape',
  near(st.shapes[0].box.x, 340) && near(st.shapes[0].box.y, 640), JSON.stringify(st.shapes[0].box));

/* ---- resize from the SE handle ---- */
let b = (await S()).shapes[0].box;
await drag(b.x + b.w, b.y + b.h, b.x + b.w + 60, b.y + b.h + 30);
st = await S();
check('dragging the SE handle resizes',
  near(st.shapes[0].box.w, b.w + 60) && near(st.shapes[0].box.h, b.h + 30), JSON.stringify(st.shapes[0].box));

/* ---- resize from the NW handle (moves origin) ---- */
b = (await S()).shapes[0].box;
await drag(b.x, b.y, b.x - 40, b.y - 10);
st = await S();
check('dragging the NW handle moves the origin',
  near(st.shapes[0].box.x, b.x - 40) && near(st.shapes[0].box.w, b.w + 40), JSON.stringify(st.shapes[0].box));

/* ---- undo / redo ---- */
const beforeUndo = JSON.stringify((await S()).shapes[0].box);
await evaluate('window.__drawOver__.undo()');
st = await S();
check('undo reverts the last edit', JSON.stringify(st.shapes[0].box) !== beforeUndo);
await evaluate('window.__drawOver__.redo()');
check('redo restores it', JSON.stringify((await S()).shapes[0].box) === beforeUndo);

/* ---- keyboard tool switch + nudge ---- */
await key('p', 'KeyP', 80);
check('"p" selects the pen', (await S()).tool === 'pen');
await drag(320, 300, 520, 380, 14);
st = await S();
check('freehand stroke recorded', st.shapes.length === 2 && st.shapes[1].type === 'pen' && st.shapes[1].pts.length > 4,
  JSON.stringify(st.shapes[1]?.pts?.length));

await key('v', 'KeyV', 86);
check('"v" returns to select', (await S()).tool === 'select');

/* ---- arrow + screen anchoring ---- */
await key('a', 'KeyA', 65);
await evaluate(`window.__drawOver__.state.space = 'screen'`);
await drag(950, 300, 1100, 420);
st = await S();
check('arrow created in screen space', st.shapes[2]?.type === 'arrow' && st.shapes[2].space === 'screen');

/* ---- text ---- */
await evaluate(`window.__drawOver__.state.space = 'page'; window.__drawOver__.state.color = '#ff3b30'`);
await key('t', 'KeyT', 84);
await mouse('mousePressed', 340, 220);
await mouse('mouseReleased', 340, 220, 0);
check('text editor opens', await evaluate(`!!document.querySelector('draw-over-9f3a2c').shadowRoot.querySelector('textarea')`));
await page.send('Input.insertText', { text: 'Subtitles hidden' });
await key('Escape', 'Escape', 27);
st = await S();
const txt = st.shapes.find((s) => s.type === 'text');
check('text committed', txt && txt.text === 'Subtitles hidden', JSON.stringify(txt));
check('empty text would be discarded', st.shapes.length === 4, String(st.shapes.length));

/* ---- shapes survive scrolling in page space, screen-anchored ones do not move ---- */
const before = await evaluate(`(()=>{const sr=document.querySelector('draw-over-9f3a2c').shadowRoot;
  const g=sr.querySelectorAll('svg > g'); return {page:g[0].getAttribute('transform'), n:g[0].children.length, screen:g[1].children.length};})()`);
check('page layer holds 3 shapes, screen layer 1', before.n === 3 && before.screen === 1, JSON.stringify(before));
await evaluate('window.scrollTo(0, 300)');
await new Promise((r) => setTimeout(r, 120));
const after = await evaluate(`document.querySelector('draw-over-9f3a2c').shadowRoot.querySelector('svg > g').getAttribute('transform')`);
check('page layer offsets on scroll', after === 'translate(0 -300)', after);
await evaluate('window.scrollTo(0, 0)');
await new Promise((r) => setTimeout(r, 120));

/* ---- click-through ---- */
await evaluate(`window.__drawOver__.handle('toggle-passthrough')`);
st = await S();
check('click-through toggles on', st.passthrough === true);
check('overlay stops capturing clicks',
  await evaluate(`getComputedStyle(document.querySelector('draw-over-9f3a2c').shadowRoot.querySelector('svg')).pointerEvents === 'none'`));
check('page is clickable underneath',
  await evaluate(`document.elementFromPoint(600,120)?.className === 'subs' || document.elementFromPoint(600,120)?.className === 'player'`),
  await evaluate(`String(document.elementFromPoint(600,120)?.className)`));
await evaluate(`window.__drawOver__.handle('toggle-passthrough')`);
check('click-through toggles back off', (await S()).passthrough === false);

/* ---- erase ---- */
await key('e', 'KeyE', 69);
b = (await S()).shapes[0].box;
await mouse('mousePressed', b.x + b.w / 2, b.y + b.h / 2);
await mouse('mouseReleased', b.x + b.w / 2, b.y + b.h / 2, 0);
st = await S();
check('eraser removes the shape under the cursor', st.shapes.length === 3 && !st.shapes.some((s) => s.type === 'rect'),
  st.shapes.map((s) => s.type).join(','));
await evaluate('window.__drawOver__.undo()');
check('erase is undoable', (await S()).shapes.length === 4);

/* ---- deactivate ---- */
await evaluate(`window.__drawOver__.handle('toggle-overlay')`);
check('toggle-overlay deactivates and hides the host',
  await evaluate(`window.__drawOver__.state.active === false && document.querySelector('draw-over-9f3a2c').hidden === true`));
await evaluate(`window.__drawOver__.handle('toggle-overlay')`);
check('shapes survive an off/on cycle', (await S()).shapes.length === 4);

const SR = `document.querySelector('draw-over-9f3a2c').shadowRoot`;

/* ---- blur box ---- */
check('blur is offered where the engine supports it',
  await evaluate(`${SR}.querySelector('[data-fill="blur"]').disabled === false`));
await evaluate(`(()=>{const D=window.__drawOver__; D.state.tool='rect'; D.state.fillMode='blur'; D.state.selected=null; D.render(true);})()`);
await drag(360, 250, 700, 310);
st = await S();
const blurShape = st.shapes.find((x) => x.fillMode === 'blur');
check('blur box created', !!blurShape, JSON.stringify(st.shapes.map((x) => x.type + '/' + x.fillMode)));
check('blur box renders a backdrop-filtered layer', await evaluate(
  `(()=>{const fo=${SR}.querySelector('foreignObject>div');
     return !!fo && /blur\\(\\d/.test(getComputedStyle(fo).backdropFilter);})()`),
  await evaluate(`(()=>{const fo=${SR}.querySelector('foreignObject>div'); return fo?getComputedStyle(fo).backdropFilter:'no foreignObject';})()`));
await evaluate(`window.__drawOver__.undo(); window.__drawOver__.state.fillMode='solid'`);

/* ---- toolbar chrome ---- */
check('all eight tool buttons sit on one row',
  await evaluate(`new Set([...${SR}.querySelectorAll('.tool')].map(b=>Math.round(b.getBoundingClientRect().top))).size === 1`));
check('active segmented buttons are visibly highlighted',
  await evaluate(`(()=>{const on=[...${SR}.querySelectorAll('.seg button')].filter(b=>b.classList.contains('on'));
    return on.length===2 && on.every(b=>getComputedStyle(b).backgroundColor==='rgb(10, 132, 255)');})()`),
  await evaluate(`[...${SR}.querySelectorAll('.seg button')].map(b=>b.textContent+':'+b.classList.contains('on')+':'+getComputedStyle(b).backgroundColor).join(' ')`));
check('toolbar stays inside the viewport',
  await evaluate(`(()=>{const r=${SR}.querySelector('.tb').getBoundingClientRect();
    return r.right<=innerWidth+1 && r.left>=0 && r.top>=0 && r.bottom<=innerHeight+1;})()`));

/* ---- screenshot ---- */
await evaluate(`window.__drawOver__.state.selected = null; window.__drawOver__.render(true)`);
const shot = await page.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, 'screenshot.png'), Buffer.from(shot.data, 'base64'));
console.log('\nwrote ' + join(OUT, 'screenshot.png'));

check('no console errors during the whole run', logs.length === 0, logs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
page.close();
browser.proc.kill();
process.exit(fail ? 1 : 0);
