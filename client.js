// Settings for dsh-notify, rendered in two seats from one body:
//
//   * `settings.section` — a first-level page in the settings panel, labelled
//     Notifications, placed last after Agent presets; and
//   * `plugins.bundle.config` — the bundle's own block on its Plugins page,
//     keyed by the package name, which is where an installed bundle is listed.
//
// Both edit the `cordis.patch.yml` row the Host reads, through this plugin's own
// `/dsh-notify/config` route. The shipped `ctx.configForms` write path is not
// reachable from a third-party bundle: it is not in the injectable Client
// service catalog, so the Host route is the one that works.
//
// React comes from the browser module table; loading a Harness Client package as
// a module is not allowed, so every control below is written locally and styled
// with `--dsw-alias-*` theme tokens.
window.__ModuleLoader__.load({
  id: '@cmwl1231/dsh-notify',
  factory(require, builtins) {
    const React = require('react');
    const h = React.createElement;

    const SCHEMA = {
      onTurnEnd: { kind: 'switch', label: ['Notify when a task finishes', '任务结束时通知'] },
      notifyEndKinds: {
        kind: 'multi',
        label: ['Which endings notify', '通知哪些结束类型'],
        hint: [
          'Pick the ways a task can end that are worth a toast.',
          '选择哪些结束情况需要弹通知。',
        ],
        choices: [
          { value: 'completed', label: ['Completed', '正常完成'] },
          { value: 'error', label: ['Failed', '出错'] },
          { value: 'max-tokens', label: ['Hit the token limit', '达到 token 上限'] },
          { value: 'aborted', label: ['Stopped by me', '我手动停止'] },
        ],
      },
      minTurnMs: {
        kind: 'number', label: ['Shortest task to notify about (ms)', '最短通知时长（毫秒）'],
        hint: ['Tasks that finish sooner stay silent.', '结束得更快的任务不弹通知。'],
        min: 0, max: 3600000, step: 500,
      },
      notifyQuestions: { kind: 'switch', label: ['Notify when the agent needs you', '需要我确认时通知'] },
      notifyPlanReviews: {
        kind: 'switch', label: ['Include plan reviews', '包含计划审核'],
        hint: ['Plan reviews have their own approval UI.', '计划审核在界面上有自己的确认框。'],
      },
      questionDelayMs: {
        kind: 'number', label: ['Question wait before notifying (ms)', '提问后等待多久再通知（毫秒）'],
        min: 0, max: 600000, step: 500,
      },
      skipWhenFocused: {
        kind: 'switch', label: ['Stay quiet while I am looking at DSH', '我正在看 DSH 时不打扰'],
        hint: [
          'No toast while a DSH tab is the foreground tab of a visible window.',
          'DSH 标签页在前台可见时，不弹通知。',
        ],
      },
      skipWhenOthersRunning: {
        kind: 'switch', label: ['Stay quiet while another session is running', '其他会话仍在运行时先不打扰'],
      },
      bodySource: {
        kind: 'select', label: ['What the notification shows', '通知显示的内容'],
        choices: [
          { value: 'answer', label: ['Last answer', '最后回复'] },
          { value: 'prompt', label: ['My prompt', '我的提问'] },
          { value: 'none', label: ['Title only', '仅标题'] },
        ],
      },
      bodyLength: { kind: 'number', label: ['Notification text length', '通知正文长度上限'], min: 20, max: 500, step: 10 },
      sound: {
        kind: 'select', label: ['Sound', '提示音'],
        choices: [
          { value: 'default', label: ['Default sound', '默认提示音'] },
          { value: 'silent', label: ['Silent', '静音'] },
          { value: 'important', label: ['Questions only', '仅需要我确认时响'] },
        ],
      },
      titleCompleted: { kind: 'text', label: ['Title when a task finishes', '任务完成时的标题'] },
      titleEnded: { kind: 'text', label: ['Title for other endings', '其他结束情况的标题'] },
      titleQuestion: { kind: 'text', label: ['Title for a question', '需要确认时的标题'] },
    };

    /** Pick the string for the page's current language. */
    function pick(pair, lang) {
      return lang === 'zh' ? pair[1] : pair[0];
    }

    // ---- styles --------------------------------------------------------------
    // Layout only. Every colour lives in STYLESHEET below.
    //
    // React assigns `style` object entries one property at a time, and a
    // `var(--token, fallback)` value written that way did not survive in this
    // bundle: the declaration was dropped, which is how the switch ended up with
    // no track colour and rendered as a white pill. A real stylesheet is parsed
    // as CSS, so the tokens and their fallbacks both work there.

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0' },
      row: {
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: '16px', padding: '12px 0',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: 1 },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { fontSize: '12px', lineHeight: '1.5' },
      control: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px' },
      input: {
        width: '128px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
        borderRadius: '6px', outline: 'none',
      },
      textInput: {
        width: '220px', padding: '5px 8px', fontSize: '13px',
        borderRadius: '6px', outline: 'none',
      },
      select: {
        padding: '5px 8px', fontSize: '13px', minWidth: '150px',
        borderRadius: '6px',
        // The drop-down list is a separate popup the page never draws, so it does
        // not inherit the closed control's colours: without this the options fall
        // back to the platform's light default and wash out in dark mode.
        colorScheme: 'light dark',
      },
      switch: {
        position: 'relative', width: '38px', height: '22px', borderRadius: '11px',
        border: 'none', padding: 0, cursor: 'pointer', flex: '0 0 auto',
      },
      knob: (on) => ({
        position: 'absolute', top: '3px', left: on ? '19px' : '3px',
        width: '16px', height: '16px', borderRadius: '50%',
        transition: 'left 120ms ease, background 120ms ease',
      }),
      sectionTitle: {
        fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
        margin: 0,
      },
      button: {
        padding: '6px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px',
      },
      status: { fontSize: '12px', lineHeight: '1.6', margin: 0, whiteSpace: 'pre-wrap' },
      note: {
        fontSize: '12px', lineHeight: '1.6', padding: '10px 12px', borderRadius: '6px',
      },
    };

    // Every colour the page uses, scoped under `.dsh-notify` so nothing leaks into
    // DSH's own settings controls.
    const STYLESHEET = `
.dsh-notify { color: var(--dsw-alias-label-primary, #e8e8e8); }
.dsh-notify-row { border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); }
.dsh-notify-row:last-child { border-bottom: none; }
.dsh-notify-label { color: var(--dsw-alias-label-primary, #e8e8e8); }
.dsh-notify-hint { color: var(--dsw-alias-label-secondary, #9a9a9a); }
.dsh-notify-section-title { color: var(--dsw-alias-label-secondary, #9a9a9a); }

.dsh-notify-input,
.dsh-notify-text,
.dsh-notify-select {
  color: var(--dsw-alias-label-primary, #e8e8e8);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
}
.dsh-notify-input:focus,
.dsh-notify-text:focus,
.dsh-notify-select:focus { border-color: var(--dsw-alias-brand-primary, #3b82f6); }

.dsh-notify-select { color-scheme: light dark; }
.dsh-notify-select option {
  color: var(--dsw-alias-label-primary, #e8e8e8);
  background: var(--dsw-alias-bg-layer-1, #2b2b2b);
}

.dsh-notify-button {
  color: var(--dsw-alias-label-primary, #e8e8e8);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
}
.dsh-notify-button:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.2)); }

.dsh-notify-note {
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08));
}

/* Chip toggles for the multi-select field. The selected/unselected colours are
   inline literals in the component; only the static shape lives here. */
.dsh-notify-chip {
  padding: 5px 12px; font-size: 12px; cursor: pointer; border-radius: 999px;
}

/* The switch. Track colour, knob colour, and knob position are inline literals in
   the component, because neither var() nor [data-on] attribute selectors took
   effect here. Only the static shape and focus ring live in this sheet. */
.dsh-notify-switch .dsh-notify-knob { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); }
.dsh-notify-switch:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 2px;
}
`;

    function Switch({ checked, onChange, label }) {
      // The on/off colour is an inline literal, not a var() and not an attribute
      // selector. Both of those failed to take effect here, and the switch has to
      // be readable whatever the stylesheet does.
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        className: 'dsh-notify-switch',
        style: {
          ...S.switch,
          background: checked ? '#3b82f6' : 'rgba(128,128,128,0.38)',
        },
        onClick: () => onChange(!checked),
      }, h('span', {
        className: 'dsh-notify-knob',
        style: { ...S.knob(checked), background: '#ffffff' },
      }));
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'dsh-notify-row', style: S.row },
        h('div', { style: S.rowText },
          h('span', { className: 'dsh-notify-label', style: S.label }, label),
          hint ? h('span', { className: 'dsh-notify-hint', style: S.hint }, hint) : null,
        ),
        h('div', { style: S.control }, children),
      );
    }

    /** One field, dispatched by the schema entry's `kind`. */
    function Field({ name, spec, value, lang, onChange }) {
      const label = pick(spec.label, lang);
      const hint = spec.hint ? pick(spec.hint, lang) : '';

      if (spec.kind === 'switch') {
        return h(Row, { label, hint },
          h(Switch, { checked: value !== false, label, onChange }),
        );
      }
      if (spec.kind === 'number') {
        return h(Row, { label, hint },
          h('input', {
            type: 'number', className: 'dsh-notify-input', style: S.input, value: value ?? 0,
            min: spec.min, max: spec.max, step: spec.step, 'aria-label': label,
            onChange: event => {
              const next = Number(event.target.value);
              onChange(Number.isFinite(next) ? next : 0);
            },
          }),
        );
      }
      if (spec.kind === 'text') {
        return h(Row, { label, hint },
          h('input', {
            type: 'text', className: 'dsh-notify-text', style: S.textInput,
            value: value ?? '', 'aria-label': label,
            onChange: event => onChange(event.target.value),
          }),
        );
      }
      if (spec.kind === 'select') {
        return h(Row, { label, hint },
          h('select', {
            className: 'dsh-notify-select', style: S.select,
            value: value ?? spec.choices[0].value, 'aria-label': label,
            onChange: event => onChange(event.target.value),
          }, spec.choices.map(choice =>
            h('option', {
              key: choice.value, value: choice.value,
            }, pick(choice.label, lang)),
          )),
        );
      }
      if (spec.kind === 'multi') {
        const chosen = Array.isArray(value) ? value : [];
        return h(Row, { label, hint },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' } },
            spec.choices.map(choice => {
              const on = chosen.includes(choice.value);
              return h('button', {
                key: choice.value, type: 'button',
                'aria-pressed': on,
                className: 'dsh-notify-chip',
                // Literal colours only. The attribute-selector version of this did
                // not visibly change the chip, so selection is drawn inline.
                style: {
                  padding: '5px 12px', fontSize: '12px', cursor: 'pointer',
                  borderRadius: '999px', fontWeight: on ? 600 : 400,
                  color: on ? '#ffffff' : '#c8c8c8',
                  background: on ? '#3b82f6' : 'rgba(128,128,128,0.22)',
                  border: `1px solid ${on ? '#3b82f6' : 'rgba(128,128,128,0.35)'}`,
                  transition: 'background 120ms ease, border-color 120ms ease',
                },
                onClick: () => onChange(on
                  ? chosen.filter(item => item !== choice.value)
                  : [...chosen, choice.value]),
              }, pick(choice.label, lang));
            }),
          ),
        );
      }
      return null;
    }

    // ---- the page ------------------------------------------------------------

    const GROUP_TITLES = [
      [['When to notify', '何时通知'], ['onTurnEnd', 'notifyEndKinds', 'minTurnMs', 'notifyQuestions', 'notifyPlanReviews', 'questionDelayMs']],
      [['Do not disturb', '免打扰'], ['skipWhenFocused', 'skipWhenOthersRunning']],
      [['What the notification says', '通知内容'], ['bodySource', 'bodyLength', 'sound', 'titleCompleted', 'titleEnded', 'titleQuestion']],
    ];

    function Settings({ lang, onTest, testing, testResult }) {
      // The values live in the Host's patch document. They are read and written
      // through this plugin's own two routes rather than through the internal
      // `configForms` service, which a third-party Client half cannot depend on:
      // it is not part of the injectable Client service catalog.
      const [state, setState] = React.useState({ status: 'loading' });
      const [draft, setDraft] = React.useState(null);
      const [pushState, setPushState] = React.useState('idle');

      React.useEffect(() => {
        let live = true;
        fetch('/dsh-notify/config', { cache: 'no-store' })
          .then(response => response.json())
          .then(body => {
            if (!live) return;
            if (!body.ok) throw new Error(body.detail ?? 'failed');
            setState({ status: 'ready', writable: body.writable !== false });
            setDraft({ ...body.config });
          })
          .catch(error => {
            if (live) setState({ status: 'unavailable', detail: String(error.message ?? error) });
          });
        return () => { live = false; };
      }, []);

      if (state.status === 'loading') {
        return h('p', { style: S.note }, pick(['Loading settings…', '正在读取设置…'], lang));
      }
      if (state.status !== 'ready' || draft === null) {
        return h('div', { style: S.wrap },
          h('p', { style: S.note }, pick(
            ['The plugin could not read its settings document.', '插件无法读取设置文档。'],
            lang,
          )),
          h('p', { style: S.status }, String(state.detail ?? '')),
        );
      }

      const set = (name, value) => {
        const next = { ...draft, [name]: value };
        setDraft(next);
        setPushState('saving');
        // Fire-and-forget writes would hide a rejected value, so the outcome is
        // reported next to the test button.
        fetch('/dsh-notify/config', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: next }),
        })
          .then(response => response.json())
          .then(body => {
            if (!body.ok) throw new Error(body.detail ?? 'failed');
            setPushState('saved');
          })
          .catch(error => {
            setPushState(`error: ${String(error.message ?? error)}`);
            // Put the stored value back rather than leaving an optimistic one.
            fetch('/dsh-notify/config', { cache: 'no-store' })
              .then(response => response.json())
              .then(body => { if (body.ok) setDraft({ ...body.config }); })
              .catch(() => {});
          });
      };

      const readOnly = state.writable === false;

      return h('div', { className: 'dsh-notify', style: S.wrap },
        readOnly
          ? h('p', { className: 'dsh-notify-note', style: S.note }, pick(
            ['Settings are read-only in this profile.', '当前 profile 的设置是只读的。'],
            lang,
          ))
          : null,

        GROUP_TITLES.map(([groupLabel, names], index) => h('div', { key: index, style: S.wrap },
          h('h3', { className: 'dsh-notify-section-title', style: S.sectionTitle }, pick(groupLabel, lang)),
          names.map(name => h(Field, {
            key: name,
            name,
            spec: SCHEMA[name],
            value: draft[name],
            lang,
            onChange: value => set(name, value),
          })),
        )),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', paddingTop: '4px' } },
          h('button', {
            type: 'button', className: 'dsh-notify-button', style: S.button, disabled: testing,
            onClick: onTest, 'aria-busy': testing,
          }, testing
            ? pick(['Sending…', '正在发送…'], lang)
            : pick(['Send a test notification', '发送测试通知'], lang)),
          testResult ? h('span', { style: S.status }, testResult) : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The page's own strings are bilingual inline, chosen from the active
        // locale, so there is no dictionary to register here: a namespace with
        // no consumers would just be a second place to keep the same text.
        const lang = String(ctx.locale.getLocale?.().active ?? 'en').startsWith('zh') ? 'zh' : 'en';

        // Every colour lives in STYLESHEET rather than in inline styles: a
        // <select>'s popup list can only be reached by a stylesheet rule.
        //
        // `styles` is a Client builtin (styles.insert), but which route exposes it
        // to a dynamic half is not guaranteed, so the known routes are tried in
        // turn and a style element is used if none answers.
        const styleRoutes = [
          ['ctx.get', () => ctx.get?.('styles')],
          ['builtins', () => builtins?.styles],
          ['ctx.styles', () => ctx.styles],
        ];
        let injected = false;
        for (const [, resolve] of styleRoutes) {
          let candidate;
          try {
            candidate = resolve();
          } catch {
            continue;
          }
          if (candidate && typeof candidate.insert === 'function') {
            candidate.insert(STYLESHEET);
            injected = true;
            break;
          }
        }
        if (!injected && typeof document !== 'undefined') {
          const element = document.createElement('style');
          element.setAttribute('data-dsh-notify', '');
          element.textContent = STYLESHEET;
          document.head.appendChild(element);
        }

        // The test toast is raised by the Host, which owns the PowerShell helper
        // and the shortcut lookup; the page only asks for one and reports the
        // answer, so a broken install shows up as a failure rather than silence.
        async function sendTest() {
          const response = await fetch('/dsh-notify/test', { method: 'POST', cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          if (!body.ok) throw new Error(body.detail ?? 'failed');
          return body;
        }

        // Both seats below render the same document and the same test button, so
        // the button's state lives in one factory instead of being written twice.
        function body() {
          const [testing, setTesting] = React.useState(false);
          const [result, setResult] = React.useState(null);
          const onTest = React.useCallback(async () => {
            setTesting(true);
            setResult(null);
            try {
              await sendTest();
              setResult(lang === 'zh' ? '测试通知已发送。' : 'Test notification sent.');
            } catch (error) {
              setResult(`${lang === 'zh' ? '发送失败' : 'Failed'}: ${String(error.message ?? error)}`);
            } finally {
              setTesting(false);
            }
          }, []);
          return h(Settings, { lang, onTest, testing, testResult: result });
        }

        // Seat one: the bundle's own page, reached from its row on the Plugins
        // page. It stays because that is where someone who installed a plugin
        // looks first, and because the row is the only place the bundle is even
        // listed.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@cmwl1231/dsh-notify',
        }, body));

        // Seat two: a first-level page in the settings panel itself, beside
        // General, Models, and the rest. Notifications are something people
        // reach for while using DSH rather than while administering a plugin,
        // and four levels down inside the Plugins page was too far for that.
        // `order: 30` places it last, after Agent presets at 20.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-notify',
          order: 30,
          label: () => (lang === 'zh' ? '通知' : 'Notifications'),
        }, body));
      },
    };
  },
});
