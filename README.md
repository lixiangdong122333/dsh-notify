# dsh-notify

Desktop notifications for [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) on Windows and macOS.

中文文档：[README.zh-CN.md](./README.zh-CN.md)

Hand a task to DSH, switch to something else, and get pulled back only when it matters: a toast tells you the task is done, or that the agent is waiting on you. Click the toast to return to the app.

> Windows 10/11 and macOS. Linux loads the plugin but cannot deliver a toast;
> its settings page still opens and says so.

## What it does

| Moment | Toast |
| --- | --- |
| A task finishes | `DSH · 任务完成` with the assistant's last answer |
| A task ends in an error or an unexpected stop | `DSH · 任务已结束` |
| The agent asks you a question and nobody answers within 6 s | `DSH · 需要你确认` with the question |

Clicking the toast, or its **打开 DeepSeek-Harness** button, brings DSH to the front. If the window is minimized it is restored; if it was closed to the tray it is reopened. On Windows this uses the `dsh://notify` URL handler that the desktop app already registers. On macOS the click comes from [terminal-notifier](https://github.com/julienXX/terminal-notifier) and reopens the app bundle; without it, notifications are still shown but clicking does nothing.

Toasts stay quiet while you are already looking at the app: the page reports from the browser whether one of its tabs is the foreground tab of a visible window, and no toast is raised in that case. Plan reviews keep their own approval UI and are not announced by default.

Everything above is adjustable in **Settings → Notifications**, the plugin's own page beside General and Models, or from its row on the Plugins page.

## Install

Published on npm — this is what the in-app **Plugin Center** uses:

```bash
dsh plugin --profile web add @cmwl1231/dsh-notify
```

For the Desktop app, replace the profile:

```bash
dsh plugin --profile desktop add @cmwl1231/dsh-notify
```

Install straight from this repository instead (no npm package involved):

```bash
dsh plugin --profile web add github:lixiangdong122333/dsh-notify
```

Quit DSH before running the command, and start it again afterwards. A newly added bundle is read at startup, not picked up live.

## Configure

Open **Settings → Notifications**, the plugin's own page in the settings panel, or **Settings → Plugins → this plugin** — both render the same form. It edits the `dsh-notify` row of your profile's `cordis.patch.yml` and applies each change immediately, with a **Send a test notification** button (where delivery is available) to confirm the whole chain works.

Editing that row by hand works just as well — both write the same block. Every key is optional; the defaults below are what an install without overrides uses.

On a Host that cannot deliver toasts — Linux, or Windows without the app's Start Menu shortcut — the page still opens and shows the settings in effect, with a note naming the reason instead of an error. The first save adds the plugin's row to the profile's `cordis.patch.yml` (the file the Host reads), so a bundle install is editable; a checkout that has no profile patch stays read-only.

The plugin's own routes are loopback-only and require its `x-dsh-notify: 1` header; the desktop shell's `dsh-app://app` origin is accepted explicitly. A remote or LAN page therefore gets a 403 instead of the form.

```yaml
- id: dsh-notify
  config:
    onTurnEnd: true              # toast when a turn ends
    notifyEndKinds:              # which endings are worth a toast
      - completed
      - error
      - max-tokens
    minTurnMs: 0                 # ignore turns shorter than this (ms)
    notifyQuestions: true        # toast for an unanswered question
    questionDelayMs: 6000        # how long a question waits before the toast
    notifyPlanReviews: false     # announce plan reviews too
    skipWhenFocused: true        # stay quiet while a DSH tab is in the foreground
    skipWhenOthersRunning: true  # stay quiet while another session still works
    bodySource: answer           # answer | prompt | none
    bodyLength: 150              # characters of body text
    sound: default               # default | silent | important
    titleCompleted: "DSH · 任务完成"
    titleEnded: "DSH · 任务已结束"
    titleQuestion: "DSH · 需要你确认"
```

`forked` and `interrupted` are handovers inside the app rather than a finished task, so they are not offered as endpoints. `sound: important` keeps only the question toast audible.

## How it works

The plugin is a Cordis plugin: it exports `apply(ctx)` and registers listeners on the host context.

* **Turns** — DSH commits a `turn/end` event to each session's log. The plugin follows that feed and raises a toast when a turn ends, skipping subagent sessions and turns you cancelled yourself.
* **Questions** — a `user-questions/request` reaches the plugin before the web answerer sees it. The plugin holds the request, and once `questionDelayMs` passes without an answer it raises the toast and steps aside, so the normal answerer takes over as usual. The plugin never answers, and never interferes with the on-screen question card.
* **Focus** — a small script served by the host reports tab visibility and focus back to the host, which is the only reliable signal for "the user can already see this".
* **Delivery** — on Windows `notify.ps1` raises the toast through WinRT as the app's Start Menu shortcut. Windows resolves a toast's application name from the `AppUserModelId` registry entry, not from the toast XML, so the script (re)writes that entry before each send. On macOS the Host spawns `terminal-notifier` when it is installed, and otherwise `osascript` (`display notification`); both are ordinary processes, so the plugin has no native dependency. macOS notifications show under the helper's own name (terminal-notifier or Script Editor), which also means the user grants notifications to that name.

## Requirements

* Windows 10 or 11 with Windows PowerShell 5.1 (present on every supported Windows), and a DeepSeek-Harness Start Menu shortcut for the app; or
* macOS with the built-in `osascript` (every supported release). `terminal-notifier` is optional and only needed for click-to-return: `brew install terminal-notifier`

## Development

```bash
# every suite: plugin logic, rendered settings page, and the macOS command plans
npm test

# toast payload and encoding checks (Windows, sends one real toast)
powershell -ExecutionPolicy Bypass -File test-toast.ps1
```

`notify.ps1` must keep its UTF-8 BOM. Windows PowerShell 5.1 reads a `.ps1` file in the system code page unless a BOM says otherwise, and the action label is Chinese — without the BOM it renders as mojibake. The test suite checks this.

## Releasing

Pushing a `v*` tag stages that version on npm; a normal push only runs the tests.

```bash
npm version 1.3.0 --no-git-tag-version
git commit -am "Release 1.3.0"
git tag v1.3.0
git push origin main --tags
```

CI checks that the tag matches `package.json` and that the version is not already published, then stages it. **The version is not installable until a maintainer approves it** at <https://www.npmjs.com/package/@cmwl1231/dsh-notify> under *Staged versions*, entering a 2FA code. The token in CI is stage-only: it can queue a release but cannot publish one, so a compromised workflow cannot ship a version nobody approved.

## License

MIT
