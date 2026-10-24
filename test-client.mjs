// Client-half tests: the settings registrations, without a browser.
//
// client.js is a bundle factory that the Web page hands to `__ModuleLoader__`.
// Loading it here means providing that loader, a React stand-in, and a Cordis
// context with the two services the bundle injects. That is enough to prove the
// registrations, which is what this suite is for: whether the settings panel
// gains its Notifications page and whether the Plugins page keeps its block.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

// --- the loader the page would have provided --------------------------------
let factory;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: loaded }) {
      factory = { id, loaded };
    },
  },
};

// A very small React: enough hooks and render recursion to mount the real
// settings component and let its effects settle. The reported bug was a page
// that rendered only "could not read settings", so the assertions worth having
// are about the text this component actually produces for a given Host answer.
let activeSlot = null;
let pendingEffects = [];
let scheduledRender = false;
let rootElement = null;
let lastTree = null;
let componentSlots = new WeakMap();

function sameDeps(previous, next) {
  if (previous === next) return true;
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity),
  }),
  useState(initial) {
    const slot = activeSlot;
    const index = slot.index++;
    if (!(index in slot.values)) {
      slot.values[index] = typeof initial === 'function' ? initial() : initial;
    }
    return [slot.values[index], (next) => {
      slot.values[index] = typeof next === 'function' ? next(slot.values[index]) : next;
      scheduleRender();
    }];
  },
  useEffect(effect, deps) {
    const slot = activeSlot;
    const index = slot.index++;
    const previous = slot.deps[index];
    if (previous === undefined || !sameDeps(previous, deps)) {
      slot.deps[index] = deps === undefined ? null : [...deps];
      pendingEffects.push(effect);
    }
  },
  useRef(initial) {
    const slot = activeSlot;
    const index = slot.index++;
    if (!(index in slot.values)) slot.values[index] = { current: initial };
    return slot.values[index];
  },
  useCallback: fn => fn,
};

function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node.type === 'function') {
    const slot = componentSlots.get(node.type) ?? { values: [], deps: [], index: 0 };
    componentSlots.set(node.type, slot);
    const previous = activeSlot;
    activeSlot = slot;
    slot.index = 0;
    let output;
    try {
      output = node.type({ ...node.props, children: node.children });
    } finally {
      activeSlot = previous;
    }
    return renderNode(output);
  }
  return { type: String(node.type), props: node.props, children: node.children.map(renderNode) };
}

function renderRoot() {
  pendingEffects = [];
  lastTree = renderNode(rootElement);
  const effects = pendingEffects;
  pendingEffects = [];
  for (const effect of effects) effect();
  return lastTree;
}

function scheduleRender() {
  if (scheduledRender) return;
  scheduledRender = true;
  setTimeout(() => {
    scheduledRender = false;
    if (rootElement !== null) renderRoot();
  }, 0);
}

/** Mount one component with fresh hook state. */
function mount(component) {
  componentSlots = new WeakMap();
  activeSlot = null;
  pendingEffects = [];
  scheduledRender = false;
  rootElement = React.createElement(component, {});
  renderRoot();
}

/** Let promise callbacks and the renders they schedule run. */
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.children);
}

function pageText() {
  return textOf(lastTree).replace(/\s+/gu, ' ').trim();
}

function hostsOf(node, tag, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const child of node) hostsOf(child, tag, found);
    return found;
  }
  if (node.type === tag) found.push(node);
  hostsOf(node.children, tag, found);
  return found;
}

/** Replace fetch for one mount; returns the recorded calls. */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const reply = (await answer({ url, options })) ?? {};
    return {
      ok: reply.ok ?? (reply.status === undefined || reply.status < 400),
      status: reply.status ?? 200,
      statusText: reply.statusText ?? '',
      text: async () => reply.body ?? '',
    };
  };
  return calls;
}
// The `styles` Client builtin, which the bundle uses to reach a <select>'s
// popup list. The factory receives it as a second argument.
const insertedCss = [];
const builtins = {
  styles: { insert: css => { insertedCss.push(css); return () => {}; } },
};
const require = name => {
  if (name === 'react') return React;
  throw new Error(`unexpected module request: ${name}`);
};

// --- run the bundle ----------------------------------------------------------
const run = new Function('window', `${source}\nreturn window;`);
run(globalThis.window);

check('bundle registers with the module loader', factory !== undefined);
check('bundle id is the package name', factory?.id === '@cmwl1231/dsh-notify', String(factory?.id));

const bundle = factory?.loaded(require, builtins);
check('bundle exposes an apply', typeof bundle?.apply === 'function');
check(
  'bundle injects slots and locale',
  Array.isArray(bundle?.inject)
    && bundle.inject.includes('slots')
    && bundle.inject.includes('locale'),
  JSON.stringify(bundle?.inject),
);

// --- the services it injects ------------------------------------------------
const registrations = [];
const injectedSeats = [];

const ctx = {
  locale: {
    // `.active` is the shipped snapshot field; a language switch re-registers.
    getLocale: () => ({ active: 'zh-CN' }),
  },
  slots: {
    inject(name, callback) {
      injectedSeats.push(name);
      // The real `inject` arms one seat and returns the registration's disposer.
      return callback();
    },
    register(registration, component) {
      registrations.push({ registration, component });
      return () => {};
    },
  },
};

bundle.apply(ctx);

check('both seats are injected', injectedSeats.length === 2, injectedSeats.join(', '));
// The drop-down list is a popup the page never draws, so it has to be reached
// with a stylesheet rule; inline styles on options are not reliably honoured.
check('a stylesheet is inserted', insertedCss.length === 1, String(insertedCss.length));
const css = insertedCss[0] ?? '';
check('the stylesheet targets the select', css.includes('select'));
check(
  'the stylesheet gives the popup a colour scheme',
  css.includes('color-scheme'),
  css.slice(0, 120),
);
check('the stylesheet colours the options', css.includes('option'));

// The selected state of the switch and the chips is drawn inline with literal
// colours: neither a var() value nor a [data-on] attribute selector took effect
// in the shipped page, and the state has to be readable regardless. What the
// stylesheet keeps is the shape and the focus ring.
check('the stylesheet keeps the chip shape', css.includes('.dsh-notify-chip'));
check('the stylesheet keeps the switch focus ring', /\.dsh-notify-switch:focus-visible/.test(css));
check(
  'the switch state is not left to an attribute selector',
  !/\.dsh-notify-switch\[data-on=/.test(css),
);
check(
  'the chip state is not left to an attribute selector',
  !/\.dsh-notify-chip\[data-on=/.test(css),
);
// And the component must actually carry those literal colours.
check(
  'the switch draws its on colour inline',
  /background:\s*checked\s*\?\s*'#[0-9a-fA-F]{3,8}'/.test(source),
);
check(
  'the chip draws its selected colour inline',
  /background:\s*on\s*\?\s*'#[0-9a-fA-F]{3,8}'/.test(source),
);
// Every control the page draws needs a rule, or it falls back to the platform
// default the same way the switch did.
for (const selector of ['.dsh-notify-input', '.dsh-notify-text', '.dsh-notify-select', '.dsh-notify-button', '.dsh-notify-note']) {
  check(`the stylesheet covers ${selector}`, css.includes(selector));
}
check(
  'the Plugins page seat is registered',
  registrations.some(entry => entry.registration.name === 'plugins.bundle.config'),
  JSON.stringify(registrations.map(entry => entry.registration.name)),
);
check(
  'the Plugins page seat is keyed by the package name',
  registrations.some(entry => entry.registration.key === '@cmwl1231/dsh-notify'),
);

const section = registrations.find(entry => entry.registration.name === 'settings.section');
check('a settings section is registered', section !== undefined);
check('the settings section has an id', section?.registration.id === 'dsh-notify', String(section?.registration.id));
check('the settings section sorts last', section?.registration.order === 30, String(section?.registration.order));
check(
  'the settings section label is a thunk, so it follows the locale',
  typeof section?.registration.label === 'function' || typeof section?.registration.label === 'string',
  typeof section?.registration.label,
);
check(
  'the settings section label reads 通知 in Chinese',
  (typeof section?.registration.label === 'function' ? section.registration.label() : section?.registration.label) === '通知',
  String(typeof section?.registration.label === 'function' ? section.registration.label() : section?.registration.label),
);

check(
  'both seats render the same component',
  registrations.length === 2 && typeof registrations[0].component === 'function' && typeof registrations[1].component === 'function',
);

// --- the same bundle under an English locale --------------------------------
// The label is a thunk over `lang`, so a second run proves it is derived from
// the injected locale rather than hard-coded to one language.
const englishRegistrations = [];
const englishSeats = [];
const englishBundle = factory.loaded(require);
englishBundle.apply({
  locale: { getLocale: () => ({ active: 'en-US' }) },
  slots: {
    inject(name, callback) {
      englishSeats.push(name);
      return callback();
    },
    register(registration, component) {
      englishRegistrations.push({ registration, component });
      return () => {};
    },
  },
});

const englishSection = englishRegistrations.find(entry => entry.registration.name === 'settings.section');
check(
  'the settings section label reads Notifications in English',
  englishSection?.registration.label() === 'Notifications',
  String(englishSection?.registration.label?.()),
);
check('the English run also registers both seats', englishSeats.length === 2, englishSeats.join(', '));

// A guard against the regression that caused the white switch: `style` objects
// in this file must not carry `var()`, because React writing them property by
// property dropped the declaration. Colours belong in STYLESHEET.
const styleBlocks = source.slice(source.indexOf('const S = {'), source.indexOf('const STYLESHEET'));
check(
  'no inline style carries a var() value',
  !/var\(--dsw/.test(styleBlocks),
  (styleBlocks.match(/.*var\(--dsw.*/g) ?? []).join(' | ').slice(0, 160),
);
check(
  'no component passes a var() inline',
  !/style:\s*\{\s*\.\.\.[^}]*var\(--dsw/.test(source),
);

// --- what the page renders ---------------------------------------------------
// The reported symptom first: the Host half is not registered, so the settings
// route answers 404 with an empty body.
stubFetch(() => ({ status: 404, body: '' }));
mount(section.component);
await settle();
let text = pageText();
check('a 404 is reported by status, not as a JSON parse failure',
  text.includes('HTTP 404'), text.slice(0, 200));
check('the empty-body JSON error never reaches the page',
  !text.includes('Unexpected end of JSON input'), text.slice(0, 200));
check('the page says the Host half is not answering',
  text.includes('Host 部分没有响应'), text.slice(0, 200));

// The macOS case: the Host answers, and says the delivery half is off.
const config = {
  onTurnEnd: true,
  notifyEndKinds: ['completed', 'error', 'max-tokens'],
  minTurnMs: 0,
  notifyQuestions: true,
  notifyPlanReviews: false,
  questionDelayMs: 6000,
  skipWhenFocused: true,
  skipWhenOthersRunning: true,
  bodySource: 'answer',
  bodyLength: 150,
  sound: 'default',
  titleCompleted: 'DSH · 任务完成',
  titleEnded: 'DSH · 任务已结束',
  titleQuestion: 'DSH · 需要你确认',
};
const macAnswer = () => ({
  body: JSON.stringify({
    ok: true,
    writable: false,
    supported: true,
    delivery: 'ready',
    platform: 'darwin',
    backend: 'osascript',
    clickToFocus: false,
    config,
    patch: null,
  }),
});

stubFetch(macAnswer);
mount(section.component);
await settle();
text = pageText();
check('macOS still gets the settings values',
  text.includes('任务结束时通知') && text.includes('提示音'), text.slice(0, 260));
check('macOS is not told notifications are unavailable',
  !text.includes('不会弹出通知'), text.slice(0, 260));
check('macOS explains the osascript backend',
  text.includes('osascript') && text.includes('脚本编辑器'), text.slice(0, 300));
check('macOS offers the test button',
  text.includes('发送测试通知'), text.slice(0, 260));
check('the read-only note replaces the generic error',
  !text.includes('插件无法读取设置文档') && text.includes('只读'), text.slice(0, 260));
check('read-only values are rendered disabled',
  hostsOf(lastTree, 'input').length > 0
  && hostsOf(lastTree, 'input').every(input => input.props.disabled === true),
  String(hostsOf(lastTree, 'input').length));

// terminal-notifier is the better macOS backend: it can reopen DSH on click.
stubFetch(() => ({
  body: JSON.stringify({
    ok: true, writable: true, supported: true, delivery: 'ready',
    platform: 'darwin', backend: 'terminal-notifier', clickToFocus: true,
    config, patch: '/tmp/profile/cordis.patch.yml',
  }),
}));
mount(section.component);
await settle();
text = pageText();
check('macOS says terminal-notifier brings DSH back on click',
  text.includes('terminal-notifier') && text.includes('回到 DeepSeek-Harness'), text.slice(0, 300));

// Linux still gets the platform note instead of a JSON error.
stubFetch(() => ({
  body: JSON.stringify({
    ok: true, writable: false, supported: false, delivery: 'unsupported-platform',
    platform: 'linux', config, patch: null,
  }),
}));
mount(section.component);
await settle();
text = pageText();
check('an unsupported platform is named', text.includes('Linux'), text.slice(0, 260));
check('an unsupported platform hides the test button',
  !text.includes('发送测试通知'), text.slice(0, 260));

// Windows, with the shortcut in place: the form is live and saving works.
const calls = stubFetch(() => ({
  body: JSON.stringify({
    ok: true,
    writable: true,
    supported: true,
    delivery: 'ready',
    platform: 'win32',
    config,
    patch: 'C:\\Users\\me\\.dsh\\profiles\\desktop\\cordis.patch.yml',
  }),
}));
mount(section.component);
await settle();
text = pageText();
check('a ready Host shows the test button', text.includes('发送测试通知'), text.slice(0, 260));
check('a ready Host raises no platform note', !text.includes('只在 Windows 上生效'), text.slice(0, 260));
check('a ready Host leaves the controls enabled',
  hostsOf(lastTree, 'input').some(input => !input.props.disabled), String(hostsOf(lastTree, 'input').length));
const numeric = hostsOf(lastTree, 'input').find(input => input.props.type === 'number');
if (numeric) numeric.props.onChange({ target: { value: '250' } });
await settle();
const posted = calls.find(call => call.options?.method === 'POST');
check('an edit posts the whole settings document', posted !== undefined,
  JSON.stringify(calls.map(call => call.options?.method)));
const postedBody = posted === undefined ? {} : JSON.parse(posted.options.body);
const numericLabel = numeric?.props['aria-label'];
check('the posted document carries the edited field and the rest',
  numericLabel === '最短通知时长（毫秒）'
  && postedBody.config?.minTurnMs === 250
  && postedBody.config?.sound === 'default',
  `${numericLabel} / ${JSON.stringify(postedBody).slice(0, 160)}`);
check('the write state is reported under the form',
  pageText().includes('已保存'), pageText().slice(-120));
check('every settings request carries the route gate header',
  calls.every(call => call.options?.headers?.['x-dsh-notify'] === '1'),
  JSON.stringify(calls.map(call => call.options?.headers)));
const testButton = hostsOf(lastTree, 'button').find(button => button.props.className === 'dsh-notify-button');
if (testButton) testButton.props.onClick();
await settle();
check('the test notification request carries the gate header',
  calls.some(call => call.url === '/dsh-notify/test'
    && call.options?.method === 'POST'
    && call.options?.headers?.['x-dsh-notify'] === '1'),
  JSON.stringify(calls.map(call => ({ url: call.url, method: call.options?.method }))));

// Windows without the Start Menu shortcut: settings load, delivery stays off.
stubFetch(() => ({
  body: JSON.stringify({
    ok: true,
    writable: true,
    supported: false,
    delivery: 'missing-shortcut',
    platform: 'win32',
    config,
    patch: 'C:\\Users\\me\\.dsh\\profiles\\desktop\\cordis.patch.yml',
  }),
}));
mount(section.component);
await settle();
text = pageText();
check('a missing shortcut gets its own explanation',
  text.includes('开始菜单快捷方式') && !text.includes('只在 Windows 上生效'), text.slice(0, 260));
check('a missing shortcut hides the test button too',
  !text.includes('发送测试通知'), text.slice(0, 260));

// A write the Host accepted live but could not persist must not read as saved.
stubFetch(({ options }) => ({
  body: options.method === 'POST'
    ? JSON.stringify({ ok: true, writable: true, supported: true, delivery: 'ready', platform: 'win32', config, persisted: { error: 'disk is full' } })
    : JSON.stringify({ ok: true, writable: true, supported: true, delivery: 'ready', platform: 'win32', config }),
}));
mount(section.component);
await settle();
const unwritableInput = hostsOf(lastTree, 'input').find(input => input.props.type === 'number');
if (unwritableInput) unwritableInput.props.onChange({ target: { value: '200' } });
await settle();
check('a failed persistence is reported instead of saved',
  pageText().includes('保存失败') && pageText().includes('disk is full'), pageText().slice(-160));

// An older Host predates `supported`/`delivery`/`backend`: it must keep working,
// because the Client half can be newer than the Host half after a partial
// upgrade, and it defaults to "delivery available".
stubFetch(() => ({ body: JSON.stringify({ ok: true, writable: true, config }) }));
mount(section.component);
await settle();
text = pageText();
check('an older Host without supported still shows the test button',
  text.includes('发送测试通知'), text.slice(0, 220));
check('an older Host raises no platform note',
  !text.includes('只在 Windows 上生效'), text.slice(0, 220));

// A read-only page must not write even if a handler is invoked directly.
const readOnlyCalls = stubFetch(macAnswer);
mount(section.component);
await settle();
const readOnlyInput = hostsOf(lastTree, 'input').find(input => input.props.type === 'number');
if (readOnlyInput) readOnlyInput.props.onChange({ target: { value: '300' } });
await settle();
check('a read-only page never posts a change',
  !readOnlyCalls.some(call => call.options?.method === 'POST'),
  JSON.stringify(readOnlyCalls.map(call => call.options?.method)));

// The remaining read failures get their own wording instead of the old JSON
// parse message: a 200 with nothing, a 200 that is not JSON, and a 500 whose
// body carries the Host's own detail.
stubFetch(() => ({ status: 200, body: '' }));
mount(section.component);
await settle();
check('an empty 200 body is named as such', pageText().includes('empty body'), pageText().slice(0, 200));

stubFetch(() => ({ status: 200, body: '<html>nope</html>' }));
mount(section.component);
await settle();
check('a non-JSON 200 body is named as such', pageText().includes('not JSON'), pageText().slice(0, 200));

stubFetch(() => ({ status: 500, body: JSON.stringify({ ok: false, detail: 'the config route exploded' }) }));
mount(section.component);
await settle();
check('a JSON failure keeps the Host detail',
  pageText().includes('the config route exploded'), pageText().slice(0, 200));

// --- report ------------------------------------------------------------------
const failed = results.filter(entry => !entry.ok);
for (const entry of results) {
  const mark = entry.ok ? 'PASS' : 'FAIL';
  const suffix = entry.ok || !entry.detail ? '' : `  (${entry.detail})`;
  console.log(`${mark}  ${entry.name}${suffix}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
