/* Draw Over — draw on top of any web page.
 * Content script: owns the overlay, the toolbar, and all editing. */
(() => {
'use strict';
if (window.__drawOverLoaded__) return;
window.__drawOverLoaded__ = true;

const api = globalThis.chrome || globalThis.browser;   // chrome.* is callback-style in both browsers
const SVGNS = 'http://www.w3.org/2000/svg';
const HOST_TAG = 'draw-over-9f3a2c';
const SETTINGS_KEY = 'settings';
const PALETTE = ['#000000', '#ffffff', '#ff3b30', '#ff9f0a', '#ffd60a', '#32d74b', '#0a84ff', '#bf5af2'];
const HANDLE = 9;          // px, selection handle size
const HIT_SLOP = 6;        // px, extra tolerance for hit testing strokes
const MIN_SIZE = 3;        // px, below this a freshly drawn shape is discarded

/* A blur box that silently fails to blur is an invisible box, which is the
 * worst outcome when you are trying to cover something. Detect and fall back. */
const BLUR_OK = (() => {
  try { return CSS.supports('backdrop-filter', 'blur(2px)') || CSS.supports('-webkit-backdrop-filter', 'blur(2px)'); }
  catch (_) { return false; }
})();
const fillModeFor = (m) => (m === 'blur' && !BLUR_OK ? 'solid' : m);

const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------------ state */

const state = {
  active: false,        // overlay visible
  passthrough: false,   // clicks go to the page instead of the overlay
  tool: 'rect',
  space: 'page',        // 'page' = sticks to document, 'screen' = sticks to viewport
  color: '#000000',
  fillMode: 'solid',    // solid | outline | blur
  width: 4,
  opacity: 1,
  fontSize: 22,
  shapes: [],
  selected: null,
  persist: false,
  collapsed: false,
  ui: { x: null, y: 16 },
};

let history = [[]];
let histIndex = 0;
let drag = null;
let editing = null;      // id of the text shape being edited
let saveTimer = null;
let lastKey = pageKey();

function pageKey() { return location.origin + location.pathname; }

/* -------------------------------------------------------------- geometry */

function normBox(b) {
  return { x: b.w < 0 ? b.x + b.w : b.x, y: b.h < 0 ? b.y + b.h : b.y, w: Math.abs(b.w), h: Math.abs(b.h) };
}
function bboxOfPts(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function shapeBox(sh) { return sh.pts ? bboxOfPts(sh.pts) : normBox(sh.box); }

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const qx = a.x + t * dx, qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}

/* Geometric hit test — avoids relying on SVG pointer-events / elementFromPoint. */
function hitShape(sh, p) {
  const box = shapeBox(sh);
  const slop = Math.max(sh.width || 2, 8) / 2 + HIT_SLOP;
  if (p.x < box.x - slop || p.x > box.x + box.w + slop || p.y < box.y - slop || p.y > box.y + box.h + slop) return false;
  switch (sh.type) {
    case 'rect':
    case 'text':
      if (sh.type === 'rect' && sh.fillMode === 'outline') {
        const inner = p.x > box.x + slop && p.x < box.x + box.w - slop && p.y > box.y + slop && p.y < box.y + box.h - slop;
        return !inner;
      }
      return true;
    case 'ellipse': {
      const rx = Math.max(box.w / 2, 1), ry = Math.max(box.h / 2, 1);
      const nx = (p.x - (box.x + rx)) / rx, ny = (p.y - (box.y + ry)) / ry;
      const d = nx * nx + ny * ny;
      if (sh.fillMode === 'outline') {
        const irx = Math.max(rx - slop, 0.5), iry = Math.max(ry - slop, 0.5);
        const ix = (p.x - (box.x + rx)) / irx, iy = (p.y - (box.y + ry)) / iry;
        return d <= 1.15 && ix * ix + iy * iy >= 1;
      }
      return d <= 1.05;
    }
    case 'line':
    case 'arrow':
      return distToSeg(p, sh.pts[0], sh.pts[1]) <= slop;
    case 'pen': {
      for (let i = 1; i < sh.pts.length; i++) if (distToSeg(p, sh.pts[i - 1], sh.pts[i]) <= slop) return true;
      return sh.pts.length === 1 && Math.hypot(p.x - sh.pts[0].x, p.y - sh.pts[0].y) <= slop;
    }
  }
  return false;
}

/* Topmost shape at a viewport point, or null. */
function shapeAt(clientX, clientY) {
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    const sh = state.shapes[i];
    if (hitShape(sh, toSpace(clientX, clientY, sh.space))) return sh;
  }
  return null;
}

/* Plenty of sites do not scroll the document at all — they scroll a full-bleed
 * inner element, leaving window.scrollY pinned at 0. Page-anchored shapes have
 * to follow whichever of the two actually moved. */
const pageOffset = { x: 0, y: 0 };
let scrollHost = null;

function isViewportScroller(el) {
  if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
  const r = el.getBoundingClientRect();
  return r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.6;
}

function updateScrollOffset(target) {
  if (isViewportScroller(target)) scrollHost = target;
  if (scrollHost && !scrollHost.isConnected) scrollHost = null;
  pageOffset.x = window.scrollX + (scrollHost ? scrollHost.scrollLeft : 0);
  pageOffset.y = window.scrollY + (scrollHost ? scrollHost.scrollTop : 0);
}

function toSpace(clientX, clientY, space) {
  return space === 'screen'
    ? { x: clientX, y: clientY }
    : { x: clientX + pageOffset.x, y: clientY + pageOffset.y };
}
function toClient(pt, space) {
  return space === 'screen' ? { x: pt.x, y: pt.y } : { x: pt.x - pageOffset.x, y: pt.y - pageOffset.y };
}

/* Move / scale a shape by remapping its geometry from one box to another. */
function applyBox(sh, nb, scaleFont) {
  const ob = shapeBox(sh);
  if (sh.pts) {
    const sx = ob.w ? nb.w / ob.w : 1, sy = ob.h ? nb.h / ob.h : 1;
    sh.pts = sh.pts.map((p) => ({ x: nb.x + (p.x - ob.x) * sx, y: nb.y + (p.y - ob.y) * sy }));
    sh.box = bboxOfPts(sh.pts);
  } else {
    if (sh.type === 'text' && scaleFont && ob.h > 0) {
      sh.fontSize = clamp(sh.fontSize * (nb.h / ob.h), 6, 400);
    }
    sh.box = { x: nb.x, y: nb.y, w: nb.w, h: nb.h };
  }
}
function moveShape(sh, dx, dy) {
  if (sh.pts) { sh.pts = sh.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })); sh.box = bboxOfPts(sh.pts); }
  else { sh.box = { ...sh.box, x: sh.box.x + dx, y: sh.box.y + dy }; }
}

/* ------------------------------------------------------------------- DOM */

let host, root, svg, pageLayer, screenLayer, uiLayer, toolbar, textarea;
let built = false;

/* The overlay is only materialised the first time it is needed, so pages you
 * never draw on are left untouched. */
function ensureBuilt() {
  if (built) return;
  built = true;
  build();
  host.hidden = true;
}

const STYLES = `
:host{all:initial!important;position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;
  width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;
  z-index:2147483647!important;pointer-events:none!important;display:block!important;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif!important;color-scheme:dark;direction:ltr}
:host([hidden]){display:none!important}
svg{position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;pointer-events:none;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
svg.live{pointer-events:auto}
svg.t-select{cursor:default}
svg.t-draw{cursor:crosshair}
svg.t-erase{cursor:cell}

.tb{position:absolute;pointer-events:auto;width:252px;background:#1c1d21;color:#e8e8ea;border:1px solid #3a3c44;
  border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.5);font-size:12px;line-height:1.3;user-select:none;overflow:hidden}
.tb.collapsed .tb-body{display:none}
.tb.collapsed{width:auto}
.tb-head{display:flex;align-items:center;gap:6px;padding:7px 8px;background:#26272d;cursor:grab;border-bottom:1px solid #34363e}
.tb.collapsed .tb-head{border-bottom:none}
.tb-head.grabbing{cursor:grabbing}
.dot{width:9px;height:9px;border-radius:50%;background:#ff453a;flex:none}
.title{flex:1;font-weight:600;letter-spacing:.2px;white-space:nowrap}
.tb-body{padding:8px}
.row{display:flex;align-items:center;gap:4px;margin-bottom:7px;flex-wrap:wrap}
.row:last-child{margin-bottom:0}
.lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:#8b8d96;width:50px;flex:none;line-height:1.15}
button{appearance:none;background:#2e3037;color:#e8e8ea;border:1px solid #3d3f48;border-radius:7px;padding:0;
  font:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center}
button:hover{background:#3a3d46}
button:disabled{opacity:.35;cursor:default}
button.on{background:#0a84ff;border-color:#0a84ff;color:#fff}
button.on:hover{background:#2b95ff}
.row.tools{display:grid;grid-template-columns:repeat(8,1fr);gap:4px}
.tool{width:auto;height:26px}
.tool svg{position:static;width:15px;height:15px;pointer-events:none;overflow:visible}
.hbtn{width:22px;height:22px;font-size:13px;background:transparent;border-color:transparent;color:#a9abb4}
.hbtn:hover{background:#3a3d46;color:#fff}
.sw{width:20px;height:20px;border-radius:50%;border:2px solid #4a4c56}
.sw.on{border-color:#fff;box-shadow:0 0 0 2px #0a84ff}
.seg{display:flex;flex:1;border:1px solid #3d3f48;border-radius:7px;overflow:hidden}
.seg button{flex:1;border:0;border-radius:0;height:23px;font-size:11px;background:#2e3037}
.seg button+button{border-left:1px solid #3d3f48}
.seg button.on{background:#0a84ff;color:#fff}
.act{height:24px;padding:0 7px;font-size:11px;gap:4px}
.grow{flex:1}
input[type=range]{flex:1;min-width:0;height:16px;accent-color:#0a84ff;background:transparent}
input[type=color]{width:22px;height:22px;padding:0;border:1px solid #4a4c56;border-radius:6px;background:#2e3037;cursor:pointer}
.num{width:30px;text-align:right;color:#a9abb4;font-variant-numeric:tabular-nums}
.hint{color:#7d7f88;font-size:10.5px;line-height:1.45;border-top:1px solid #34363e;padding-top:6px;margin-top:2px}
kbd{background:#33353d;border:1px solid #45474f;border-bottom-width:2px;border-radius:4px;padding:0 3px;font:inherit;font-size:9.5px}
textarea{position:absolute;pointer-events:auto;margin:0;padding:0;border:0;outline:1px dashed #0a84ff;background:rgba(10,132,255,.10);
  resize:none;overflow:hidden;white-space:pre;line-height:1.25;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  caret-color:#0a84ff;min-width:24px}
`;

const ICONS = {
  select: '<path d="M3 2l9 7h-4.2l-1.7 4z" fill="currentColor"/>',
  rect: '<rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  ellipse: '<ellipse cx="8" cy="8" rx="5.8" ry="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  line: '<path d="M3 13L13 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  arrow: '<path d="M3 13L12.2 3.8M13 3l-.5 5M13 3l-5 .5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  pen: '<path d="M2.5 13.5c3-1 2-4 4.5-6.5S12 3 13.5 2.5c-.5 1.5-1 4-3.5 6.5s-5.5 1.5-6.5 4.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  text: '<path d="M3 3h10M8 3v10M6 13h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  erase: '<path d="M6.5 13.5H13M2.5 10.5l4-4 5 5-2.5 2.5H5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
};
const TOOL_LIST = [
  ['select', 'Select & edit  (V)'],
  ['rect', 'Rectangle  (R)'],
  ['ellipse', 'Ellipse  (O)'],
  ['line', 'Line  (L)'],
  ['arrow', 'Arrow  (A)'],
  ['pen', 'Free draw — freehand pen  (P)'],
  ['text', 'Text  (T)'],
  ['erase', 'Erase  (E)'],
];

function el(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function build() {
  host = document.createElement(HOST_TAG);
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  root = host.attachShadow({ mode: 'open' });

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    root.adoptedStyleSheets = [sheet];
  } catch (_) {
    const s = document.createElement('style');
    s.textContent = STYLES;
    root.appendChild(s);
  }

  svg = el('svg', { xmlns: SVGNS });
  pageLayer = el('g');
  screenLayer = el('g');
  uiLayer = el('g');
  svg.append(pageLayer, screenLayer, uiLayer);
  root.appendChild(svg);

  buildToolbar();
  svg.addEventListener('pointerdown', onPointerDown, true);
  svg.addEventListener('wheel', onWheel, { passive: false });
  (document.body || document.documentElement).appendChild(host);
  syncScroll();
}

function buildToolbar() {
  toolbar = document.createElement('div');
  toolbar.className = 'tb';
  toolbar.innerHTML = `
    <div class="tb-head">
      <span class="dot"></span><span class="title">Draw Over</span>
      <button class="hbtn" data-act="collapse" title="Collapse">–</button>
      <button class="hbtn" data-act="off" title="Turn off (Alt+Shift+D)">✕</button>
    </div>
    <div class="tb-body">
      <div class="row tools" data-tools></div>
      <div class="row" data-colors></div>
      <div class="row">
        <span class="lbl">Box style</span>
        <div class="seg">
          <button data-fill="solid" title="Filled — covers what is underneath">Solid</button>
          <button data-fill="outline" title="Outline only">Outline</button>
          <button data-fill="blur" title="Blur what is underneath">Blur</button>
        </div>
      </div>
      <div class="row">
        <span class="lbl" data-wlabel>Stroke</span>
        <input type="range" data-act="width" min="1" max="60" step="1">
        <span class="num" data-wval></span>
      </div>
      <div class="row">
        <span class="lbl">Opacity</span>
        <input type="range" data-act="opacity" min="5" max="100" step="5">
        <span class="num" data-oval></span>
      </div>
      <div class="row">
        <span class="lbl">Anchor</span>
        <div class="seg">
          <button data-space="page" title="Scrolls with the page. Sets the default for new shapes, and re-anchors the selected one.">Page</button>
          <button data-space="screen" title="Stays put on screen — good for video players and fullscreen. Sets the default for new shapes, and re-anchors the selected one.">Screen</button>
        </div>
      </div>
      <div class="row">
        <button class="act" data-act="undo" title="Undo (Ctrl+Z)">↶</button>
        <button class="act" data-act="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        <button class="act" data-act="back" title="Send to back ([)">⤓</button>
        <button class="act" data-act="front" title="Bring to front (])">⤒</button>
        <button class="act" data-act="dup" title="Duplicate (Ctrl+D)">⧉</button>
        <button class="act" data-act="del" title="Delete selected (Del)">🗑</button>
      </div>
      <div class="row">
        <button class="act grow" data-act="through" title="Let clicks reach the page (Esc / Alt+Shift+X)">Click page</button>
        <button class="act grow" data-act="persist" title="Reload these drawings whenever you visit this page">Remember</button>
        <button class="act" data-act="clear" title="Delete every shape on this page">Clear</button>
      </div>
      <div class="hint" data-hint></div>
    </div>`;

  const tools = toolbar.querySelector('[data-tools]');
  for (const [id, title] of TOOL_LIST) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.title = title;
    b.setAttribute('data-tool', id);
    b.innerHTML = `<svg viewBox="0 0 16 16" xmlns="${SVGNS}">${ICONS[id]}</svg>`;
    tools.appendChild(b);
  }

  const colors = toolbar.querySelector('[data-colors]');
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.setAttribute('data-color', c);
    b.title = c;
    b.style.background = c;
    colors.appendChild(b);
  }
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.setAttribute('data-act', 'pick');
  picker.title = 'Custom colour';
  colors.appendChild(picker);

  toolbar.addEventListener('pointerdown', onToolbarPointerDown);
  toolbar.addEventListener('click', onToolbarClick);
  toolbar.addEventListener('input', onToolbarInput);
  root.appendChild(toolbar);
}

/* --------------------------------------------------------------- render */

const nodes = new Map();   // shape id -> { g, type, fillMode, parts }

function svgTagFor(sh) {
  if (sh.type === 'rect') return sh.fillMode === 'blur' ? 'foreignObject' : 'rect';
  if (sh.type === 'ellipse') return sh.fillMode === 'blur' ? 'foreignObject' : 'ellipse';
  if (sh.type === 'line') return 'line';
  if (sh.type === 'arrow') return 'g';
  if (sh.type === 'pen') return 'path';
  return 'text';
}

function createNode(sh) {
  const g = el('g');
  g.setAttribute('data-id', sh.id);
  const parts = {};
  const tag = svgTagFor(sh);
  if (tag === 'foreignObject') {
    parts.main = el('foreignObject');
    const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    div.style.width = '100%';
    div.style.height = '100%';
    parts.div = div;
    parts.main.appendChild(div);
  } else if (sh.type === 'arrow') {
    parts.main = el('g');
    parts.line = el('line');
    parts.head = el('path');
    parts.main.append(parts.line, parts.head);
  } else {
    parts.main = el(tag);
  }
  g.appendChild(parts.main);
  return { g, type: sh.type, fillMode: sh.fillMode, parts };
}

function penPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y} l 0.01 0.01`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function updateNode(rec, sh) {
  const p = rec.parts;
  const box = shapeBox(sh);
  const op = sh.opacity != null ? sh.opacity : 1;
  const stroked = sh.fillMode === 'outline' || sh.type === 'line' || sh.type === 'arrow' || sh.type === 'pen';

  if (sh.type === 'rect' || sh.type === 'ellipse') {
    if (sh.fillMode === 'blur') {
      p.main.setAttribute('x', box.x); p.main.setAttribute('y', box.y);
      p.main.setAttribute('width', Math.max(box.w, 0)); p.main.setAttribute('height', Math.max(box.h, 0));
      p.main.setAttribute('opacity', op);
      p.div.style.backdropFilter = `blur(${Math.max(sh.width, 1)}px)`;
      p.div.style.webkitBackdropFilter = `blur(${Math.max(sh.width, 1)}px)`;
      p.div.style.borderRadius = sh.type === 'ellipse' ? '50%' : '2px';
    } else {
      if (sh.type === 'rect') {
        p.main.setAttribute('x', box.x); p.main.setAttribute('y', box.y);
        p.main.setAttribute('width', Math.max(box.w, 0)); p.main.setAttribute('height', Math.max(box.h, 0));
      } else {
        p.main.setAttribute('cx', box.x + box.w / 2); p.main.setAttribute('cy', box.y + box.h / 2);
        p.main.setAttribute('rx', Math.max(box.w / 2, 0)); p.main.setAttribute('ry', Math.max(box.h / 2, 0));
      }
      p.main.setAttribute('fill', stroked ? 'none' : sh.color);
      p.main.setAttribute('stroke', stroked ? sh.color : 'none');
      p.main.setAttribute('stroke-width', sh.width);
      p.main.setAttribute('opacity', op);
    }
  } else if (sh.type === 'line' || sh.type === 'arrow') {
    const [a, b] = sh.pts;
    const head = sh.type === 'arrow' ? Math.max(9, sh.width * 3.2) : 0;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const ex = b.x - Math.cos(ang) * head * 0.75, ey = b.y - Math.sin(ang) * head * 0.75;
    const line = sh.type === 'arrow' ? p.line : p.main;
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', sh.type === 'arrow' ? ex : b.x); line.setAttribute('y2', sh.type === 'arrow' ? ey : b.y);
    line.setAttribute('stroke', sh.color);
    line.setAttribute('stroke-width', sh.width);
    line.setAttribute('stroke-linecap', 'round');
    if (sh.type === 'arrow') {
      const s = 0.42;
      p.head.setAttribute('d', `M ${b.x} ${b.y} L ${b.x - Math.cos(ang - s) * head} ${b.y - Math.sin(ang - s) * head} L ${b.x - Math.cos(ang + s) * head} ${b.y - Math.sin(ang + s) * head} Z`);
      p.head.setAttribute('fill', sh.color);
    }
    p.main.setAttribute('opacity', op);
  } else if (sh.type === 'pen') {
    p.main.setAttribute('d', penPath(sh.pts));
    p.main.setAttribute('fill', 'none');
    p.main.setAttribute('stroke', sh.color);
    p.main.setAttribute('stroke-width', sh.width);
    p.main.setAttribute('stroke-linecap', 'round');
    p.main.setAttribute('stroke-linejoin', 'round');
    p.main.setAttribute('opacity', op);
  } else if (sh.type === 'text') {
    const t = p.main;
    while (t.firstChild) t.removeChild(t.firstChild);
    t.setAttribute('fill', sh.color);
    t.setAttribute('font-size', sh.fontSize);
    t.setAttribute('opacity', editing === sh.id ? 0 : op);
    t.setAttribute('x', box.x);
    const lines = String(sh.text || '').split('\n');
    lines.forEach((ln, i) => {
      const ts = el('tspan', { x: box.x, y: box.y + sh.fontSize * 0.925 + i * sh.fontSize * 1.25 });
      ts.textContent = ln.length ? ln : ' ';
      t.appendChild(ts);
    });
  }
  rec.g.style.pointerEvents = 'none';
}

/* Text boxes size themselves from the rendered glyphs. */
function measureText(sh, rec) {
  try {
    const bb = rec.parts.main.getBBox();
    const lines = String(sh.text || '').split('\n').length;
    sh.box = { x: sh.box.x, y: sh.box.y, w: Math.max(bb.width, sh.fontSize * 0.6), h: lines * sh.fontSize * 1.25 };
  } catch (_) { /* not laid out yet */ }
}

function render(structural) {
  if (!state.active) return;
  const seen = new Set();
  for (const sh of state.shapes) {
    seen.add(sh.id);
    let rec = nodes.get(sh.id);
    if (!rec || rec.type !== sh.type || rec.fillMode !== sh.fillMode) {
      if (rec) rec.g.remove();
      rec = createNode(sh);
      nodes.set(sh.id, rec);
      structural = true;
    }
    updateNode(rec, sh);
    if (sh.type === 'text') {
      const layer = sh.space === 'screen' ? screenLayer : pageLayer;
      if (rec.g.parentNode !== layer) layer.appendChild(rec.g);
      measureText(sh, rec);
    }
  }
  for (const [id, rec] of nodes) if (!seen.has(id)) { rec.g.remove(); nodes.delete(id); }

  if (structural) {
    for (const sh of state.shapes) {
      const rec = nodes.get(sh.id);
      (sh.space === 'screen' ? screenLayer : pageLayer).appendChild(rec.g);
    }
  }
  renderHandles();
  updateToolbar();
}

function selectedShape() { return state.shapes.find((s) => s.id === state.selected) || null; }

const HANDLE_DIRS = [
  ['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5],
  ['se', 1, 1], ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5],
];

function handlePoints(sh) {
  const b = shapeBox(sh);
  return HANDLE_DIRS.map(([dir, fx, fy]) => ({ dir, x: b.x + b.w * fx, y: b.y + b.h * fy }));
}

function renderHandles() {
  while (uiLayer.firstChild) uiLayer.removeChild(uiLayer.firstChild);
  const sh = selectedShape();
  if (!sh || state.tool !== 'select' || state.passthrough) return;
  const off = sh.space === 'screen' ? { x: 0, y: 0 } : { x: -pageOffset.x, y: -pageOffset.y };
  const g = el('g', { transform: `translate(${off.x} ${off.y})` });
  const b = shapeBox(sh);
  g.appendChild(el('rect', {
    x: b.x - 1, y: b.y - 1, width: b.w + 2, height: b.h + 2,
    fill: 'none', stroke: '#0a84ff', 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
  }));
  for (const h of handlePoints(sh)) {
    g.appendChild(el('rect', {
      x: h.x - HANDLE / 2, y: h.y - HANDLE / 2, width: HANDLE, height: HANDLE,
      rx: 2, fill: '#fff', stroke: '#0a84ff', 'stroke-width': 1.5,
    }));
  }
  uiLayer.appendChild(g);
}

function handleAt(clientX, clientY) {
  const sh = selectedShape();
  if (!sh || state.tool !== 'select') return null;
  for (const h of handlePoints(sh)) {
    const c = toClient(h, sh.space);
    if (Math.abs(clientX - c.x) <= HANDLE && Math.abs(clientY - c.y) <= HANDLE) return h.dir;
  }
  return null;
}

let scrollQueued = false;
function syncScroll() {
  pageLayer.setAttribute('transform', `translate(${-pageOffset.x} ${-pageOffset.y})`);
  renderHandles();
  if (editing) positionTextarea();
}
function onScroll(e) {
  updateScrollOffset(e && e.target);
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; if (state.active) syncScroll(); });
}

/* While the overlay is capturing the pointer it also swallows the wheel, and the
 * browser then scrolls the document rather than whatever is under the cursor.
 * Forward the scroll to the element the user is actually pointing at. */
const SCROLLY = /auto|scroll|overlay/;

function pageElementAt(x, y) {
  const prev = svg.style.pointerEvents;
  svg.style.pointerEvents = 'none';
  const el = document.elementFromPoint(x, y);
  svg.style.pointerEvents = prev;
  return el;
}

function nearestScrollable(el, dx, dy) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n === document.body || n === document.documentElement) break;
    const cs = getComputedStyle(n);
    if (dy && SCROLLY.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
      const atEnd = dy > 0 ? n.scrollTop >= n.scrollHeight - n.clientHeight - 1 : n.scrollTop <= 0;
      if (!atEnd) return n;
    }
    if (dx && SCROLLY.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) return n;
  }
  return null;
}

function onWheel(e) {
  if (!state.active || state.passthrough) return;
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
  else if (e.deltaMode === 2) { dx *= window.innerWidth; dy *= window.innerHeight; }
  const target = nearestScrollable(pageElementAt(e.clientX, e.clientY), dx, dy);
  if (!target) return;                  // nothing custom under the cursor: let the document scroll
  e.preventDefault();
  target.scrollLeft += dx;
  target.scrollTop += dy;
  onScroll({ target });
}

/* ------------------------------------------------------------ pointer IO */

function updateCursor() {
  svg.classList.toggle('live', state.active && !state.passthrough);
  svg.classList.toggle('t-select', state.tool === 'select');
  svg.classList.toggle('t-erase', state.tool === 'erase');
  svg.classList.toggle('t-draw', state.tool !== 'select' && state.tool !== 'erase');
}

function onPointerDown(e) {
  if (!state.active || state.passthrough || e.button !== 0) return;
  if (editing) { commitText(); return; }
  e.preventDefault();
  e.stopPropagation();
  try { svg.setPointerCapture(e.pointerId); } catch (_) {}   // synthetic/odd pointer ids

  if (state.tool === 'select') {
    const dir = handleAt(e.clientX, e.clientY);
    if (dir) {
      const sh = selectedShape();
      drag = { mode: 'resize', dir, id: sh.id, start: toSpace(e.clientX, e.clientY, sh.space), box0: shapeBox(sh) };
      return;
    }
    const hit = shapeAt(e.clientX, e.clientY);
    state.selected = hit ? hit.id : null;
    if (hit) drag = { mode: 'move', id: hit.id, last: toSpace(e.clientX, e.clientY, hit.space), moved: false };
    render();
    return;
  }

  if (state.tool === 'erase') {
    drag = { mode: 'erase', hitAny: false };
    eraseAt(e.clientX, e.clientY);
    return;
  }

  const pt = toSpace(e.clientX, e.clientY, state.space);
  const sh = newShape(state.tool, pt);
  state.shapes.push(sh);
  state.selected = sh.id;
  if (state.tool === 'text') {
    drag = null;
    render(true);
    startTextEdit(sh);
    return;
  }
  drag = { mode: 'create', id: sh.id, start: pt };
  render(true);
}

function newShape(type, pt) {
  const s = {
    id: uid(), type, space: state.space, color: state.color,
    width: state.width, opacity: state.opacity,
  };
  if (type === 'rect' || type === 'ellipse') { s.fillMode = fillModeFor(state.fillMode); s.box = { x: pt.x, y: pt.y, w: 0, h: 0 }; }
  else if (type === 'line' || type === 'arrow') { s.pts = [{ ...pt }, { ...pt }]; s.box = { x: pt.x, y: pt.y, w: 0, h: 0 }; }
  else if (type === 'pen') { s.pts = [{ ...pt }]; s.box = { x: pt.x, y: pt.y, w: 0, h: 0 }; }
  else if (type === 'text') { s.text = ''; s.fontSize = state.fontSize; s.box = { x: pt.x, y: pt.y, w: 0, h: 0 }; }
  return s;
}

function onPointerMove(e) {
  if (!drag) return;
  const sh = drag.id ? state.shapes.find((s) => s.id === drag.id) : null;

  if (drag.mode === 'erase') { eraseAt(e.clientX, e.clientY); return; }
  if (!sh) return;
  const pt = toSpace(e.clientX, e.clientY, sh.space);

  if (drag.mode === 'create') {
    if (sh.type === 'rect' || sh.type === 'ellipse') {
      let w = pt.x - drag.start.x, h = pt.y - drag.start.y;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      sh.box = normBox({ x: drag.start.x, y: drag.start.y, w, h });
    } else if (sh.type === 'line' || sh.type === 'arrow') {
      let p = { ...pt };
      if (e.shiftKey) p = snapAngle(drag.start, p);
      sh.pts[1] = p;
      sh.box = bboxOfPts(sh.pts);
    } else if (sh.type === 'pen') {
      const last = sh.pts[sh.pts.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) > 1.5) { sh.pts.push(pt); sh.box = bboxOfPts(sh.pts); }
    }
  } else if (drag.mode === 'move') {
    moveShape(sh, pt.x - drag.last.x, pt.y - drag.last.y);
    drag.last = pt;
    drag.moved = true;
  } else if (drag.mode === 'resize') {
    const b0 = drag.box0;
    let dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    let x = b0.x, y = b0.y, w = b0.w, h = b0.h;
    if (drag.dir.includes('w')) { x = b0.x + dx; w = b0.w - dx; }
    if (drag.dir.includes('e')) { w = b0.w + dx; }
    if (drag.dir.includes('n')) { y = b0.y + dy; h = b0.h - dy; }
    if (drag.dir.includes('s')) { h = b0.h + dy; }
    const corner = drag.dir.length === 2;
    if (e.shiftKey && corner && b0.w && b0.h) {
      const r = b0.h / b0.w;
      h = Math.sign(h || 1) * Math.abs(w) * r;
      if (drag.dir.includes('n')) y = b0.y + b0.h - h;
    }
    const nb = normBox({ x, y, w, h });
    nb.w = Math.max(nb.w, 1); nb.h = Math.max(nb.h, 1);
    applyBox(sh, nb, corner);
  }
  render();
}

function snapAngle(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
  return { x: a.x + Math.cos(ang) * d, y: a.y + Math.sin(ang) * d };
}

function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  try { svg.releasePointerCapture(e.pointerId); } catch (_) {}

  if (d.mode === 'create') {
    const sh = state.shapes.find((s) => s.id === d.id);
    if (sh) {
      const b = shapeBox(sh);
      const tiny = sh.type === 'pen' ? sh.pts.length < 2 : (b.w < MIN_SIZE && b.h < MIN_SIZE);
      if (tiny) {
        state.shapes = state.shapes.filter((s) => s.id !== sh.id);
        state.selected = null;
        render(true);
        return;
      }
      state.tool = 'select';   // drop straight into edit mode on the new shape
    }
  } else if (d.mode === 'move' && !d.moved) {
    render();
    return;                    // a plain click, nothing to record
  } else if (d.mode === 'erase' && !d.hitAny) {
    return;
  }
  commit();
  render(true);
}

function eraseAt(cx, cy) {
  const hit = shapeAt(cx, cy);
  if (!hit) return;
  state.shapes = state.shapes.filter((s) => s.id !== hit.id);
  if (state.selected === hit.id) state.selected = null;
  if (drag) drag.hitAny = true;
  render(true);
}

/* ------------------------------------------------------------------ text */

function startTextEdit(sh) {
  editing = sh.id;
  textarea = document.createElement('textarea');
  textarea.value = sh.text || '';
  textarea.spellcheck = false;
  textarea.style.fontSize = sh.fontSize + 'px';
  textarea.style.color = sh.color;
  textarea.style.opacity = String(sh.opacity);
  root.appendChild(textarea);
  positionTextarea();
  textarea.focus();
  textarea.select();
  textarea.addEventListener('input', () => {
    const s = state.shapes.find((x) => x.id === editing);
    if (s) { s.text = textarea.value; render(); }
    positionTextarea();
  });
  textarea.addEventListener('blur', commitText);
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitText(); }
  });
  render();
}

function positionTextarea() {
  const sh = state.shapes.find((x) => x.id === editing);
  if (!sh || !textarea) return;
  const c = toClient({ x: sh.box.x, y: sh.box.y }, sh.space);
  const lines = textarea.value.split('\n');
  const cols = Math.max(...lines.map((l) => l.length), 1);
  textarea.style.left = c.x + 'px';
  textarea.style.top = c.y + 'px';
  textarea.style.width = Math.max(cols * sh.fontSize * 0.62 + 12, 30) + 'px';
  textarea.style.height = lines.length * sh.fontSize * 1.25 + 2 + 'px';
}

function commitText() {
  if (!editing) return;
  const id = editing;
  editing = null;
  const sh = state.shapes.find((x) => x.id === id);
  if (textarea) { if (sh) sh.text = textarea.value; textarea.remove(); textarea = null; }
  if (sh && !String(sh.text).trim()) {
    state.shapes = state.shapes.filter((s) => s.id !== id);
    if (state.selected === id) state.selected = null;
  } else {
    state.tool = 'select';
    commit();
  }
  render(true);
}

/* --------------------------------------------------------------- history */

function commit() {
  history = history.slice(0, histIndex + 1);
  history.push(clone(state.shapes));
  if (history.length > 120) history.shift();
  histIndex = history.length - 1;
  scheduleSave();
}
function restore(i) {
  histIndex = clamp(i, 0, history.length - 1);
  state.shapes = clone(history[histIndex]);
  if (!state.shapes.some((s) => s.id === state.selected)) state.selected = null;
  scheduleSave();
  render(true);
}
const undo = () => restore(histIndex - 1);
const redo = () => restore(histIndex + 1);

/* --------------------------------------------------------------- storage */

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}
function save() {
  if (!api?.storage?.local) return;
  const key = 'page:' + lastKey;
  if (!state.persist || !state.shapes.length) api.storage.local.remove(key);
  else api.storage.local.set({ [key]: { shapes: state.shapes, saved: Date.now() } });
  saveSettings();
}
function saveSettings() {
  if (!api?.storage?.local) return;
  api.storage.local.set({
    [SETTINGS_KEY]: {
      tool: state.tool, space: state.space, color: state.color, fillMode: state.fillMode,
      width: state.width, opacity: state.opacity, fontSize: state.fontSize,
      collapsed: state.collapsed, ui: state.ui,
    },
  });
}

/* storage.local.get is callback-style in Firefox and promise-style in Chrome MV3;
 * this resolves under either (whichever answers first wins). */
function storageGet(keys) {
  return new Promise((resolve) => {
    if (!api || !api.storage || !api.storage.local) return resolve({});
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || {}); } };
    try {
      const r = api.storage.local.get(keys, finish);
      if (r && typeof r.then === 'function') r.then(finish, () => finish({}));
    } catch (_) { finish({}); }
  });
}

async function loadStored() {
  const got = await storageGet([SETTINGS_KEY, 'page:' + lastKey]);
  return { settings: got[SETTINGS_KEY] || null, page: got['page:' + lastKey] || null };
}

/* ------------------------------------------------------------- toolbar IO */

function onToolbarPointerDown(e) {
  const head = e.target.closest('.tb-head');
  if (!head || e.target.closest('button')) return;
  e.preventDefault();
  const r = toolbar.getBoundingClientRect();
  const ox = e.clientX - r.left, oy = e.clientY - r.top;
  head.classList.add('grabbing');
  const move = (ev) => {
    state.ui.x = clamp(ev.clientX - ox, 0, window.innerWidth - r.width);
    state.ui.y = clamp(ev.clientY - oy, 0, window.innerHeight - 30);
    placeToolbar();
  };
  const up = () => {
    head.classList.remove('grabbing');
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    saveSettings();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
}

function onToolbarClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  const sel = selectedShape();

  if (b.hasAttribute('data-tool')) {
    state.tool = b.getAttribute('data-tool');
    if (state.tool !== 'select') state.selected = null;
    state.passthrough = false;
  } else if (b.hasAttribute('data-color')) {
    setStyle('color', b.getAttribute('data-color'));
  } else if (b.hasAttribute('data-fill')) {
    setStyle('fillMode', b.getAttribute('data-fill'));
  } else if (b.hasAttribute('data-space')) {
    const sp = b.getAttribute('data-space');
    state.space = sp;
    if (sel) { const p = toClient(shapeBox(sel), sel.space); sel.space = sp; const n = toSpace(p.x, p.y, sp); moveShape(sel, n.x - shapeBox(sel).x, n.y - shapeBox(sel).y); commit(); }
  } else {
    switch (b.getAttribute('data-act')) {
      case 'collapse': state.collapsed = !state.collapsed; saveSettings(); break;
      case 'off': deactivate(); return;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'del': if (sel) { state.shapes = state.shapes.filter((s) => s.id !== sel.id); state.selected = null; commit(); } break;
      case 'dup': if (sel) { const c = clone(sel); c.id = uid(); moveShape(c, 14, 14); state.shapes.push(c); state.selected = c.id; commit(); } break;
      case 'front': if (sel) { state.shapes = state.shapes.filter((s) => s !== sel).concat([sel]); commit(); } break;
      case 'back': if (sel) { state.shapes = [sel].concat(state.shapes.filter((s) => s !== sel)); commit(); } break;
      case 'clear': if (state.shapes.length) { state.shapes = []; state.selected = null; commit(); } break;
      case 'through': setPassthrough(!state.passthrough); break;
      case 'persist': state.persist = !state.persist; save(); break;
    }
  }
  render(true);
}

function onToolbarInput(e) {
  const t = e.target;
  const act = t.getAttribute('data-act');
  if (act === 'width') setStyle('width', +t.value);
  else if (act === 'opacity') setStyle('opacity', +t.value / 100);
  else if (act === 'pick') setStyle('color', t.value);
  render();
}

/* Style changes apply to the selection when there is one, otherwise to the next shape. */
function setStyle(key, value) {
  if (key === 'fillMode') value = fillModeFor(value);
  state[key] = value;
  const sel = selectedShape();
  if (sel) {
    if (key === 'fillMode' && sel.type !== 'rect' && sel.type !== 'ellipse') { /* n/a */ }
    else if (key === 'width' && sel.type === 'text') sel.fontSize = clamp(value * 5, 8, 300);
    else sel[key] = value;
    commit();
  }
  saveSettings();
}

function placeToolbar() {
  if (state.ui.x == null) state.ui.x = Math.max(8, window.innerWidth - 252 - 18);
  const w = toolbar.offsetWidth || 252;
  toolbar.style.left = clamp(state.ui.x, 0, Math.max(0, window.innerWidth - w)) + 'px';
  toolbar.style.top = clamp(state.ui.y, 0, Math.max(0, window.innerHeight - 40)) + 'px';
}

function updateToolbar() {
  const sel = selectedShape();
  toolbar.classList.toggle('collapsed', state.collapsed);
  toolbar.querySelector('[data-act="collapse"]').textContent = state.collapsed ? '+' : '–';
  for (const b of toolbar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.getAttribute('data-tool') === state.tool);
  for (const b of toolbar.querySelectorAll('[data-color]')) b.classList.toggle('on', b.getAttribute('data-color') === state.color);
  for (const b of toolbar.querySelectorAll('[data-fill]')) b.classList.toggle('on', b.getAttribute('data-fill') === state.fillMode);
  const blurBtn = toolbar.querySelector('[data-fill="blur"]');
  blurBtn.disabled = !BLUR_OK;
  if (!BLUR_OK) blurBtn.title = 'This browser cannot blur page content — use Solid to cover it';
  for (const b of toolbar.querySelectorAll('[data-space]')) b.classList.toggle('on', b.getAttribute('data-space') === state.space);
  toolbar.querySelector('[data-act="through"]').classList.toggle('on', state.passthrough);
  toolbar.querySelector('[data-act="persist"]').classList.toggle('on', state.persist);
  toolbar.querySelector('[data-act="undo"]').disabled = histIndex <= 0;
  toolbar.querySelector('[data-act="redo"]').disabled = histIndex >= history.length - 1;
  for (const a of ['del', 'dup', 'front', 'back']) toolbar.querySelector(`[data-act="${a}"]`).disabled = !sel;

  const isText = sel ? sel.type === 'text' : state.tool === 'text';
  const isBlur = (sel && (sel.type === 'rect' || sel.type === 'ellipse') ? sel.fillMode : state.fillMode) === 'blur';
  toolbar.querySelector('[data-wlabel]').textContent = isText ? 'Text size' : isBlur ? 'Blur amount' : 'Stroke';
  const wIn = toolbar.querySelector('[data-act="width"]');
  const wv = sel && sel.type === 'text' ? Math.round(sel.fontSize / 5) : (sel ? sel.width : state.width);
  if (document.activeElement !== wIn && root.activeElement !== wIn) wIn.value = wv;
  toolbar.querySelector('[data-wval]').textContent = isText ? Math.round(wv * 5) + 'px' : wv;
  const oIn = toolbar.querySelector('[data-act="opacity"]');
  const ov = Math.round((sel ? sel.opacity : state.opacity) * 100);
  if (root.activeElement !== oIn) oIn.value = ov;
  toolbar.querySelector('[data-oval]').textContent = ov + '%';
  toolbar.querySelector('[data-act="pick"]').value = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#000000';

  toolbar.querySelector('[data-hint]').innerHTML = state.passthrough
    ? 'Click-through is <b>on</b> — the page works normally. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> to draw again.'
    : sel
      ? 'Drag to move, pull a handle to resize. <kbd>Del</kbd> removes it, <kbd>Esc</kbd> deselects.'
      : `<b>${state.tool === 'select' ? 'Click a shape to edit it' : 'Drag on the page to draw'}</b> · <kbd>Esc</kbd> click-through · <kbd>V</kbd> select`;
  placeToolbar();
}

/* -------------------------------------------------------------- keyboard */

const TOOL_KEYS = { v: 'select', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', p: 'pen', t: 'text', e: 'erase' };

function onKeyDown(e) {
  if (!state.active || editing) return;
  const sel = selectedShape();
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape' && !state.passthrough) {
    stop(e);
    if (state.selected) { state.selected = null; render(true); }
    else setPassthrough(true);
    return;
  }
  if (state.passthrough) return;

  if (mod && e.key.toLowerCase() === 'z') { stop(e); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { stop(e); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') {
    stop(e);
    if (sel) { const c = clone(sel); c.id = uid(); moveShape(c, 14, 14); state.shapes.push(c); state.selected = c.id; commit(); render(true); }
    return;
  }
  if (mod) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!sel) return;
    stop(e);
    state.shapes = state.shapes.filter((s) => s.id !== sel.id);
    state.selected = null;
    commit(); render(true);
    return;
  }
  if (sel && e.key.startsWith('Arrow')) {
    stop(e);
    const d = e.shiftKey ? 10 : 1;
    moveShape(sel, e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0,
                   e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
    commit(); render();
    return;
  }
  if (sel && (e.key === '[' || e.key === ']')) {
    stop(e);
    state.shapes = e.key === ']' ? state.shapes.filter((s) => s !== sel).concat([sel]) : [sel].concat(state.shapes.filter((s) => s !== sel));
    commit(); render(true);
    return;
  }
  if (e.key === 'Enter' && sel && sel.type === 'text') { stop(e); startTextEdit(sel); return; }

  const t = TOOL_KEYS[e.key.toLowerCase()];
  if (t) {
    stop(e);
    state.tool = t;
    if (t !== 'select') state.selected = null;
    render(true);
  }
}
function stop(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }

function onDblClick(e) {
  if (!state.active || state.passthrough || state.tool !== 'select') return;
  const hit = shapeAt(e.clientX, e.clientY);
  if (hit && hit.type === 'text') { stop(e); state.selected = hit.id; render(true); startTextEdit(hit); }
}

/* ---------------------------------------------------------------- toggles */

function setPassthrough(on) {
  state.passthrough = on;
  if (on && editing) commitText();
  updateCursor();
  render(true);
}

function activate() {
  ensureBuilt();
  if (state.active) return;
  state.active = true;
  host.hidden = false;
  updateCursor();
  render(true);
  reportStatus();
}
function deactivate() {
  if (!state.active) return;
  if (editing) commitText();
  state.active = false;
  state.selected = null;
  drag = null;
  host.hidden = true;
  reportStatus();
}
function reportStatus() {
  try { api?.runtime?.sendMessage({ type: 'status', active: state.active }); } catch (_) {}
}

/* ------------------------------------------------------------- fullscreen */

function onFullscreenChange() {
  if (!built) return;
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const target = fs || document.body || document.documentElement;
  if (host.parentNode !== target) target.appendChild(host);
}

/* ----------------------------------------------------- SPA URL bookkeeping */

setInterval(() => {
  const k = pageKey();
  if (k === lastKey) return;
  if (state.persist) {
    save();
    lastKey = k;
    storageGet('page:' + k).then((got) => {
      const data = got['page:' + k];
      state.shapes = data ? clone(data.shapes) : [];
      state.selected = null;
      history = [clone(state.shapes)];
      histIndex = 0;
      if (state.shapes.length && !state.active) activate();
      render(true);
    });
  } else {
    lastKey = k;
  }
}, 1000);

/* ------------------------------------------------------------------- boot */

window.addEventListener('pointermove', onPointerMove, true);
window.addEventListener('pointerup', onPointerUp, true);
window.addEventListener('pointercancel', onPointerUp, true);
window.addEventListener('dblclick', onDblClick, true);
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('scroll', onScroll, true);
window.addEventListener('resize', () => { updateScrollOffset(null); if (state.active) { syncScroll(); placeToolbar(); } }, true);
document.addEventListener('fullscreenchange', onFullscreenChange, true);
document.addEventListener('webkitfullscreenchange', onFullscreenChange, true);

loadStored().then(({ settings, page }) => {
  if (settings) Object.assign(state, settings);
  if (page && page.shapes && page.shapes.length) {
    state.persist = true;
    state.shapes = clone(page.shapes);
    history = [clone(state.shapes)];
    histIndex = 0;
    activate();
    setPassthrough(true);   // restored drawings start out of the way
  }
  if (built) placeToolbar();
});

/* Debug handle. Content scripts run in an isolated world, so this is not
 * reachable from page scripts; it exists for the test harness. */
window.__drawOver__ = {
  state, activate, deactivate, setPassthrough, render, undo, redo,
  getHistory: () => ({ length: history.length, index: histIndex }),
  handle: (type) => onMessage({ type }),
};

function onMessage(msg, _sender, sendResponse) {
  switch (msg && msg.type) {
    case 'ping': break;
    case 'toggle-overlay':
      if (!state.active) { activate(); setPassthrough(false); }
      else if (state.passthrough) setPassthrough(false);   // drawings restored/parked -> start drawing
      else deactivate();
      break;
    case 'toggle-passthrough':
      if (!state.active) { activate(); setPassthrough(false); }
      else setPassthrough(!state.passthrough);
      break;
    case 'toggle-edit':
      if (!state.active) activate();
      setPassthrough(false);
      state.tool = state.tool === 'select' ? 'rect' : 'select';
      state.selected = state.tool === 'select' ? state.selected : null;
      updateCursor();
      render(true);
      break;
  }
  if (sendResponse) sendResponse({ ok: true, active: state.active });
  return false;
}

if (api && api.runtime && api.runtime.onMessage) api.runtime.onMessage.addListener(onMessage);
})();
