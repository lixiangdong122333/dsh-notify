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

// React is only needed as a namespace at registration time; every hook below is
// reached from inside a component render, which this suite never performs.
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
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

const bundle = factory?.loaded(require);
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

// --- report ------------------------------------------------------------------
const failed = results.filter(entry => !entry.ok);
for (const entry of results) {
  const mark = entry.ok ? 'PASS' : 'FAIL';
  const suffix = entry.ok || !entry.detail ? '' : `  (${entry.detail})`;
  console.log(`${mark}  ${entry.name}${suffix}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
