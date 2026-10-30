# Per-Project Extensions

Run VS Code with **only the extensions a project needs**, to save memory, CPU and startup time.

Each project declares its extensions in `.vscode/required-extensions.json`:

```json
{
  "required": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "ms-python.python"
  ]
}
```

A bare array (`["ms-python.python"]`) also works. **Only listed extensions stay enabled**; everything else is
disabled, including themes, icon themes, grammars and snippets. Add `"keepDeclarativeExtensions": true` to keep those
code-less extensions (they cost almost nothing at runtime) without listing each one.

Always kept in addition to the list:

- this extension,
- dependencies (`extensionDependencies`) of required extensions,
- IDs in the `projectExtensions.alwaysEnabled` setting (handy in *user* settings for things you want everywhere, e.g. Copilot, Vim),
- built-in extensions (never touched).

## How it's applied

The VS Code API can't enable or disable other extensions, so the extension uses the `code` CLI in one of two ways:

| Command | What happens | Persistence |
|---|---|---|
| **Open in Project Profile** (recommended) | Closes the window and reopens the folder in a profile named `Project - <folder>` that contains only the required extensions. The first time, your `settings.json`, `keybindings.json`, `tasks.json` and snippets are copied into it. Running it again syncs the profile, installing new entries and uninstalling removed ones. | Permanent: VS Code remembers the profile for that folder. |
| **Reopen Window With Unrequired Extensions Disabled** | Closes the window and reopens it with `--disable-extension` for every extension that isn't required. | That window only. |

**Both are scoped to this project only.** Other folders keep your default profile with every extension enabled.
If another folder ever ends up in a `Project - …` profile (for example via *File > Open Folder* from that window),
it is detected on startup and you're offered to reopen it in the Default profile. To go back to all extensions for this
project, run **Reopen in Default Profile (All Extensions)**.

Both run a small detached helper after the window closes; its log is in the extension's global storage (`relaunch.log`).

## Creating the file

When the extension is enabled and a folder has no `.vscode/required-extensions.json`, it creates one on startup
listing every installed extension, so nothing is disabled until you trim the list.

- **Per-Project Extensions: Review Required Extensions** (or click the status bar item) shows every installed extension
  as a checklist and saves the checked ones to the file. If the file doesn't exist yet, the list is pre-filled by
  scanning the project: file languages, `activationEvents` (`onLanguage`, `workspaceContains`), `package.json`
  dependencies (eslint, prettier, vue, jest…), config files (Dockerfile, Cargo.toml, go.mod…), and
  `.vscode/extensions.json` recommendations.
- **Detect Required Extensions From Project (Re-scan)** ignores the existing file and suggests a list from scratch.
- **Open required-extensions.json** opens the file for editing. A JSON schema provides validation.

**The file stays in sync automatically.** Installing an extension while this project's window is focused adds it to
`required-extensions.json`; uninstalling removes it, even when the extension keeps running until restart.
Other open windows are left alone. In a project profile, changes made while the manager wasn't running are
picked up the next time the window opens. Turn this off with `projectExtensions.syncOnInstall`.

On startup in a project with the file, if extensions that aren't listed are running, you're offered to switch.
The status bar shows how many installed extensions aren't required.

## Footprint

The extension is built to stay out of the way:

- **It loads after startup finishes** (`onStartupFinished`), so it never slows down opening a window.
- **It never scans your project in the background.** The file scan runs only when you run *Detect* or *Review*
  without a file.
- **Two tiny watchers.** One on `required-extensions.json`, one on the profile's installed-extensions list. No polling,
  no timers.
- **One ~20 KB minified bundle.** The relaunch helper is a separate short-lived process that exits when done.
- **"Open in Project Profile" sets `window.newWindowProfile` to `Default`** (unless you already set it). VS Code would
  otherwise give folders opened from a project-profile window that project's profile, so this keeps project profiles
  project-only without the extension having to run everywhere.

## Settings

| Setting | Default | |
|---|---|---|
| `projectExtensions.enabled` | `true` | Master switch. `false` stops all background work (status bar, watchers, startup check, sync) immediately; commands offer to re-enable. Works in user or workspace `settings.json`. |
| `projectExtensions.alwaysEnabled` | `[]` | Extra IDs kept in every project. |
| `projectExtensions.keepDeclarativeExtensions` | `false` | Also keep unlisted themes, grammars, snippets and keymaps. |
| `projectExtensions.syncOnInstall` | `true` | Add/remove entries in the file when you install/uninstall extensions. |
| `projectExtensions.notifyOnStartup` | `true` | Prompt when unrequired extensions are running. |
| `projectExtensions.maxFilesToScan` | `5000` | Files sampled during detection. |
| `projectExtensions.excludeGlob` | `node_modules`, `dist`… | Skipped during detection. |
| `projectExtensions.cliPath` | `""` | Use a specific `code` CLI instead of the bundled one. |

## Limitations

- Only local folders and workspaces are supported; remote (SSH/WSL/containers) is not.
- Detection sees only extensions enabled in the current window. Extensions listed in the file but disabled or not
  installed are still installed into the project profile.
- A new profile window starts empty for a few seconds while the extensions install. If something looks missing, run
  **Developer: Reload Window** there.
- Settings copied into a new profile are a snapshot. Later changes to your default profile's settings aren't synced.

## Develop

Set up following the official guides for
[bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension) and
[testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension).
CI and releasing are described in [PUBLISHING.md](PUBLISHING.md).

| Command | What it does |
|---|---|
| `npm install` | Install dev dependencies |
| `npm run compile` | Type-check, then bundle `src/` into `dist/` with esbuild |
| `npm run watch` | Rebuild on change (also the default build task, Ctrl+Shift+B) |
| `npm test` | Run the integration tests inside a downloaded VS Code (`.vscode-test/`) |
| `npm run package` | Production (minified) bundle; runs automatically before `vsce package` |
| `npm run vsix` | Build `per-project-extensions-<version>.vsix` |

**Debugging:** press **F5** (*Run Extension*). To run or debug single tests, install the recommended
[Extension Test Runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner) and use
the Testing view.

**Tests** live in `src/test/`, compile to `out/test/` (tests are not bundled) and open
`test-fixtures/test-project` with all other extensions disabled.

**Manual sandbox:** a separate VS Code with its own settings and test extensions in `.sandbox/`, so you can try
profiles and relaunching without touching your own setup.

| Command | What it does |
|---|---|
| `npm run sandbox:setup` | Install the test extensions into the sandbox (once) |
| `npm run sandbox:install` | Package and install this extension into the sandbox |
| `npm run sandbox:open` | Open `test-fixtures/sample-project` in the sandbox |
| `npm run sandbox:open-default` | Same, forced into the Default profile |
| `npm run sandbox:list` | List extensions installed in the sandbox |
