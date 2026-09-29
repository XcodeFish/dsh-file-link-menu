// Minimal DOM-stub harness: runs the plugin's factory + apply + a synthetic
// right-click, so the menu-build path is exercised without a browser.
import { readFileSync } from 'node:fs';

function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: { cssText: '' },
    attrs: {},
    isConnected: true,
    className: '',
    textContent: '',
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    remove() { this.isConnected = false; },
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key] ?? null; },
    addEventListener() {},
    removeEventListener() {},
    replaceChildren() { this.children = []; },
    querySelector(selector) { return findByClass(this, selector); },
    closest() { return null; },
    getBoundingClientRect() { return { left: 10, top: 10, width: 220, height: 160 }; },
  };
  return node;
}

function findByClass(root, selector) {
  if (!selector.startsWith('.')) return null;
  const cls = selector.slice(1);
  const stack = [...(root.children ?? [])];
  while (stack.length) {
    const current = stack.shift();
    if (typeof current.className === 'string' && current.className.split(/\s+/).includes(cls)) return current;
    if (current.children?.length) stack.push(...current.children);
  }
  return null;
}

const registry = {};
const handlers = {};

global.window = {
  __ModuleLoader__: { load(spec) { registry[spec.id] = spec; } },
  addEventListener(type, fn) { handlers[`window:${type}`] = fn; },
  removeEventListener() {},
  innerWidth: 1440,
  innerHeight: 900,
  setTimeout,
};
global.document = {
  head: makeEl('head'),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  createElement: makeEl,
  createTextNode(text) { const node = makeEl('#text'); node.textContent = text; return node; },
  getElementById() { return null; },
  addEventListener(type, fn) { handlers[`document:${type}`] = fn; },
  removeEventListener() {},
};
const fakeNavigator = { clipboard: { writeText: async () => {} } };

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
new Function('window', 'document', 'navigator', 'console', source)(
  global.window, global.document, fakeNavigator, console,
);

const spec = registry['dsh-file-link-menu'];
if (!spec) throw new Error('module loader never registered dsh-file-link-menu');
const mod = spec.factory(() => { throw new Error('unexpected require'); });

const calls = [];
const ctx = {
  remote: {
    session: {
      openWorkspacePath: async (request) => { calls.push(['open', request]); return { ok: true }; },
      workspacePathApplications: async () => ({ ok: true, value: [{ id: 'vscode', name: 'VS Code', default: true }] }),
    },
  },
  sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/Users/guobinbin/QAIT/qait-web' } } }) } },
  slots: { inject() {}, register() {} },
  effect(fn) { return fn(); },
};

mod.apply(ctx);
const onContextMenu = handlers['window:contextmenu'];
if (typeof onContextMenu !== 'function') throw new Error('contextmenu listener was not registered');

// 1) right-click a markdown file link: <button title="<path>">
const button = makeEl('button');
button.attrs.title = 'src/devices/h5/runtime.ts';
const plainCode = makeEl('code');

function fire(target) {
  const event = {
    target,
    clientX: 120,
    clientY: 200,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  onContextMenu(event);
  return event;
}

const event = fire({ closest: (sel) => (sel.includes('button') ? button : null) });
console.log('body children:', global.document.body.children.map((c) => c.id || c.className || c.tagName));
const probe = global.document.body.children.find((c) => c.id === 'flm-probe');
if (probe) console.log('probe text:', probe.textContent);
const menu = findByClass(global.document.body, '.flm-menu');
console.log('button[title] right-click ->', event.defaultPrevented ? 'intercepted' : 'ignored',
  '| menu:', menu ? `built (${menu.children.length} blocks)` : 'MISSING');
if (!menu) throw new Error('menu was not built for button[title] target');

// 2) right-click a keyword inside inline code: must stay untouched
const codeEvent = fire({ closest: (sel) => (sel.includes('code') ? plainCode : null) });
console.log('inline code (no path) ->', codeEvent.defaultPrevented ? 'intercepted (WRONG)' : 'left to native menu (ok)');

console.log('\nROUND TRIP OK — menu build path no longer throws');
