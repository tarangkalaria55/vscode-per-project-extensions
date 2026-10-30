import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AnalysisResult,
  analyze,
  ExtensionReport,
  REQUIRED_FILE,
  RequiredFile,
  readRequiredFile,
  requiredFileUri,
  isBuiltin,
  selfId,
  writeRequiredFile,
} from './analyzer';
import type { Job } from './relauncher';

let channel: vscode.OutputChannel | undefined;
let status: vscode.StatusBarItem | undefined;
let subscriptions: vscode.Disposable[] = [];
/** Everything that runs in the background; disposed when `projectExtensions.enabled` is turned off. */
let running: vscode.Disposable[] = [];
/** Bumped on every start/stop so async startup work from a previous run can tell it is stale. */
let generation = 0;

/** Created on first use: most sessions never log anything. */
function output(): vscode.OutputChannel {
  if (!channel) subscriptions.push((channel = vscode.window.createOutputChannel('Per-Project Extensions')));
  return channel;
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('projectExtensions').get<boolean>('enabled', true);
}

export function activate(context: vscode.ExtensionContext): void {
  subscriptions = context.subscriptions;

  const reg = (id: string, fn: () => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        if (!isEnabled()) {
          const pick = await vscode.window.showInformationMessage(
            'Per-Project Extensions is disabled (projectExtensions.enabled is false).',
            'Enable',
          );
          if (pick !== 'Enable') return;
          await vscode.workspace
            .getConfiguration('projectExtensions')
            .update('enabled', true, vscode.ConfigurationTarget.Global);
        }
        try {
          await fn();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Project Extensions: ${e?.message ?? e}`);
        }
      }),
    );

  reg('projectExtensions.analyze', () => reviewAndSave(false));
  reg('projectExtensions.detect', () => reviewAndSave(true));
  reg('projectExtensions.openFile', openRequiredFile);
  reg('projectExtensions.createProfile', () => apply(context, 'profile'));
  reg('projectExtensions.openLean', () => apply(context, 'lean'));
  reg('projectExtensions.showActive', showReport);
  reg('projectExtensions.useDefaultProfile', () => reopenInProfile(context, DEFAULT_PROFILE));

  // React to the enabled flag at runtime, no reload needed.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('projectExtensions.enabled')) return;
      if (isEnabled()) start(context);
      else stop();
    }),
    { dispose: stop },
  );

  if (isEnabled()) start(context);
}

const STARTUP_DELAY_MS = 3000;

export function deactivate(): void {}

/** Starts the status bar item, watchers and the deferred startup check. */
function start(context: vscode.ExtensionContext): void {
  stop();
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return;
  const gen = generation;

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'projectExtensions.analyze';
  // Watch the single file only, not a workspace-wide glob.
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `.vscode/${REQUIRED_FILE}`));
  watcher.onDidChange(scheduleStatus);
  watcher.onDidCreate(scheduleStatus);
  watcher.onDidDelete(scheduleStatus);

  // Stay out of the way while VS Code and other extensions start up; nothing here is urgent.
  const timer = setTimeout(() => {
    watchInstalledExtensions(context, gen)
      .then(() => (gen === generation ? startupCheck(context) : undefined))
      .catch((e) => output().appendLine(`startup check failed: ${e}`));
  }, STARTUP_DELAY_MS);

  running.push(status, watcher, { dispose: () => clearTimeout(timer) }, { dispose: () => clearTimeout(statusTimer) });
}

/** Disposes everything started by start(); the extension then does no work until re-enabled. */
function stop(): void {
  generation++;
  for (const d of running.splice(0)) d.dispose();
  status = undefined;
}

/* ------------------------------------------------------------------- sync */

/**
 * The installed-extensions list of this window's profile (`extensions.json`). VS Code updates it the moment an
 * extension is installed or uninstalled, whereas `vscode.extensions.all` keeps listing an uninstalled extension
 * that was running until the extension host restarts.
 */
async function installedListPath(context: vscode.ExtensionContext): Promise<string | undefined> {
  const profile = await currentProfile(context);
  if (profile) return path.join(userDir(context), 'profiles', profile.location, 'extensions.json');
  const dir = extensionsDir(context);
  return dir && path.join(dir, 'extensions.json');
}

/** Lower-cased ID -> ID of installed extensions (this extension excluded); undefined if unreadable (mid-write). */
async function readInstalled(file: string): Promise<Map<string, string> | undefined> {
  try {
    const list = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!Array.isArray(list)) return undefined;
    const self = selfId();
    const ids: string[] = list.map((e: any) => String(e?.identifier?.id ?? '')).filter(Boolean);
    return new Map(ids.filter((id) => id.toLowerCase() !== self).map((id) => [id.toLowerCase(), id]));
  } catch {
    return undefined;
  }
}

async function watchInstalledExtensions(context: vscode.ExtensionContext, gen: number): Promise<void> {
  const file = await installedListPath(context);
  if (!file) return;
  let known = (await readInstalled(file)) ?? new Map<string, string>();
  if (gen !== generation) return; // disabled while we were reading
  let pending = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const onChange = () => {
    clearTimeout(timer);
    // VS Code may write the file several times per operation; wait for it to settle.
    timer = setTimeout(() => {
      // Serialize reads/writes so quick install/uninstall sequences don't race on the file.
      pending = pending
        .then(async () => {
          const now = await readInstalled(file);
          if (!now) return;
          const previous = known;
          known = now;
          await syncRequiredFile(previous, now);
        })
        .catch((e) => output().appendLine(`sync failed: ${e}`));
    }, 500);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
  );
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  running.push(watcher, { dispose: () => clearTimeout(timer) });
}

/**
 * Mirrors installs/uninstalls into required-extensions.json.
 * Installs are shared by every open window, so only the focused window, where the user acted, updates its file.
 */
async function syncRequiredFile(
  before: Map<string, string>,
  after: Map<string, string>,
  ignoreFocus = false,
): Promise<void> {
  if (!vscode.workspace.getConfiguration('projectExtensions').get<boolean>('syncOnInstall', true)) return;
  if (!ignoreFocus && !vscode.window.state.focused) return;

  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = new Set([...before.keys()].filter((id) => !after.has(id)));
  if (!added.length && !removed.size) return;

  const file = await readRequiredFile();
  if (!file) return;
  const listed = new Set(file.required.map((id) => id.toLowerCase()));
  const toAdd = added.filter((id) => !listed.has(id)).map((id) => after.get(id)!);
  const toRemove = file.required.filter((id) => removed.has(id.toLowerCase()));
  if (!toAdd.length && !toRemove.length) return;

  await writeRequiredFile([...file.required.filter((id) => !removed.has(id.toLowerCase())), ...toAdd]);

  const parts = [
    toAdd.length ? `added ${toAdd.join(', ')}` : '',
    toRemove.length ? `removed ${toRemove.join(', ')}` : '',
  ].filter(Boolean);
  output().appendLine(`${REQUIRED_FILE}: ${parts.join('; ')}`);
  vscode.window.setStatusBarMessage(`$(extensions) ${REQUIRED_FILE}: ${parts.join('; ')}`, 6000);
  await refreshStatus();
}

/* ----------------------------------------------------------------- status */

function runningUnneeded(result: AnalysisResult): ExtensionReport[] {
  return result.reports.filter((r) => r.verdict === 'unneeded' && (r.isActive || r.eager));
}

let statusTimer: NodeJS.Timeout | undefined;

/** Coalesces bursts of file events into one status refresh. */
function scheduleStatus(): void {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => refreshStatus().catch(() => undefined), 300);
}

async function refreshStatus(): Promise<AnalysisResult | undefined> {
  const item = status;
  if (!item || !vscode.workspace.workspaceFolders?.length) return undefined; // disabled
  // Without the file there is nothing to report; never scan the project in the background.
  if (!(await readRequiredFile())) {
    item.hide();
    return undefined;
  }
  const result = await analyze();
  const active = runningUnneeded(result);
  const unneeded = result.reports.filter((r) => r.verdict === 'unneeded').length;
  if (unneeded === 0) {
    item.text = '$(extensions) Lean';
    item.tooltip = 'Only required extensions are enabled.';
  } else {
    item.text = `$(extensions) ${unneeded} not required`;
    item.tooltip = `${unneeded} installed extensions are not required by this project (${active.length} running). Click to review.`;
  }
  item.show();
  return result;
}

async function startupCheck(context: vscode.ExtensionContext): Promise<void> {
  // A project profile must never spread to other folders (e.g. via File > Open Folder in that window).
  const current = (await currentProfile(context))?.name;
  if (current?.startsWith(PROFILE_PREFIX) && current !== profileName()) {
    const pick = await vscode.window.showWarningMessage(
      `This folder opened in "${current}", which only has another project's extensions.`,
      'Reopen in Default Profile',
    );
    if (pick) await reopenInProfile(context, DEFAULT_PROFILE, false);
    return;
  }

  // In this project's own profile the installed list *is* the project's list, so catch up on
  // installs/uninstalls made while the manager wasn't running.
  const installedFile = await installedListPath(context);
  const installed = installedFile && (await readInstalled(installedFile));
  const file = (await readRequiredFile()) ?? (await createFromInstalled(installed || undefined));
  if (current === profileName() && installed && file) {
    // Right after "Open in Project Profile" the helper is still installing; don't mistake that for uninstalls.
    const listed = (await recentlyRelaunched(context))
      ? new Map<string, string>()
      : new Map(file.required.map((id) => [id.toLowerCase(), id]));
    await syncRequiredFile(listed, installed, true);
  }

  const result = await refreshStatus();
  if (!result || result.source !== 'file') return;
  if (!vscode.workspace.getConfiguration('projectExtensions').get<boolean>('notifyOnStartup', true)) return;

  const active = runningUnneeded(result);
  if (!active.length) return;
  const choice = await vscode.window.showInformationMessage(
    `${active.length} extension(s) not listed in ${REQUIRED_FILE} are running in this window.`,
    'Create Project Profile',
    'Reopen Lean',
    'Show',
    "Don't Ask Again",
  );
  if (choice === 'Create Project Profile') await apply(context, 'profile');
  else if (choice === 'Reopen Lean') await apply(context, 'lean');
  else if (choice === 'Show') showReport();
  else if (choice === "Don't Ask Again") {
    await vscode.workspace
      .getConfiguration('projectExtensions')
      .update('notifyOnStartup', false, vscode.ConfigurationTarget.Workspace);
  }
}

/**
 * Starts a missing required-extensions.json with every installed extension, so nothing is disabled until the user
 * trims the list. A file that exists but doesn't parse is left alone.
 */
async function createFromInstalled(installed: Map<string, string> | undefined): Promise<RequiredFile | undefined> {
  const uri = requiredFileUri();
  if (!uri) return undefined;
  try {
    await vscode.workspace.fs.stat(uri);
    return undefined;
  } catch {
    // Doesn't exist yet.
  }
  const ids = installed
    ? [...installed.values()]
    : vscode.extensions.all.filter((e) => !isBuiltin(e) && e.id.toLowerCase() !== selfId()).map((e) => e.id);
  await writeRequiredFile(ids);
  const message = `Created ${vscode.workspace.asRelativePath(uri)} with ${ids.length} installed extension(s)`;
  output().appendLine(message);
  vscode.window.setStatusBarMessage(`$(extensions) ${message}`, 6000);
  return { required: ids };
}

/* --------------------------------------------------------------- commands */

async function openRequiredFile(): Promise<void> {
  const uri = requiredFileUri();
  if (!uri) throw new Error('Open a folder first.');
  if (!(await readRequiredFile())) {
    const pick = await vscode.window.showInformationMessage(
      `${REQUIRED_FILE} does not exist yet.`,
      'Generate From Project',
      'Create Empty',
    );
    if (pick === 'Generate From Project') {
      await reviewAndSave(true);
      return;
    }
    if (pick !== 'Create Empty') return;
    await writeRequiredFile([]);
  }
  await vscode.window.showTextDocument(uri);
}

/** Shows every installed extension with a checkbox; saves the checked ones to required-extensions.json. */
async function reviewAndSave(forceDetect: boolean): Promise<boolean> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Analyzing project extensions…' },
    () => analyze(forceDetect),
  );
  const existing = forceDetect ? undefined : await readRequiredFile();

  // Extensions kept regardless of the file are not worth listing.
  const implicit = (r: ExtensionReport) =>
    r.id.toLowerCase() === selfId() || r.reason.startsWith('no code') || r.reason.includes('alwaysEnabled');

  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = result.reports
    .filter((r) => !implicit(r))
    .map((r) => ({
      id: r.id,
      label: r.displayName,
      description: [r.id, r.eager ? '$(zap) starts eagerly' : '', r.isActive ? '$(play) running' : '']
        .filter(Boolean)
        .join('  '),
      detail: r.reason,
      picked: r.verdict === 'required',
    }));

  const qp = vscode.window.createQuickPick<Item>();
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.items = items;
  qp.selectedItems = items.filter((i) => i.picked);
  qp.title =
    result.source === 'file'
      ? `Edit .vscode/${REQUIRED_FILE}`
      : `Suggested required extensions (from project scan). Confirm to save .vscode/${REQUIRED_FILE}`;
  qp.placeholder = 'Check the extensions this project needs. Themes and code-less extensions are always kept.';

  const selected = await new Promise<readonly Item[] | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!selected) return false;

  // Keep IDs from the existing file that aren't installed here; they are still required.
  const keep = (existing?.required ?? []).filter(
    (id) => !result.reports.some((r) => r.id.toLowerCase() === id.toLowerCase()),
  );
  const uri = await writeRequiredFile([...selected.map((s) => s.id), ...keep]);
  await refreshStatus();

  const next = await vscode.window.showInformationMessage(
    `Saved ${selected.length + keep.length} required extension(s) to ${vscode.workspace.asRelativePath(uri)}.`,
    'Create Project Profile',
    'Reopen Lean',
    'Open File',
  );
  if (next === 'Open File') await vscode.window.showTextDocument(uri);
  else if (next) await vscode.commands.executeCommand(
    next === 'Reopen Lean' ? 'projectExtensions.openLean' : 'projectExtensions.createProfile',
  );
  return true;
}

function showReport(): Promise<void> {
  return analyze().then((result) => {
    output().clear();
    output().appendLine(`Source: ${result.source === 'file' ? `.vscode/${REQUIRED_FILE}` : 'project scan (no file yet)'}\n`);
    for (const verdict of ['required', 'unneeded'] as const) {
      const list = result.reports.filter((r) => r.verdict === verdict);
      output().appendLine(`${verdict.toUpperCase()} (${list.length})`);
      for (const r of list) {
        const flags = [r.isActive ? 'running' : '', r.eager ? 'eager' : ''].filter(Boolean).join(', ');
        output().appendLine(`  ${r.id.padEnd(45)} ${flags ? `[${flags}] ` : ''}${r.reason}`);
      }
      output().appendLine('');
    }
    if (result.missing.length) {
      output().appendLine(`REQUIRED BUT NOT INSTALLED HERE (${result.missing.length})`);
      for (const id of result.missing) output().appendLine(`  ${id}`);
    }
    output().show(true);
  });
}

/* ------------------------------------------------------------------ apply */

function workspaceTarget(): string {
  const wsFile = vscode.workspace.workspaceFile;
  if (wsFile && wsFile.scheme === 'file') return wsFile.fsPath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a folder first.');
  if (folder.uri.scheme !== 'file') throw new Error('Remote workspaces are not supported yet.');
  return folder.uri.fsPath;
}

/** `<user-data-dir>/User`, derived from this extension's global storage location. */
function userDir(context: vscode.ExtensionContext): string {
  let dir = context.globalStorageUri.fsPath;
  while (path.basename(dir) !== 'User' && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/** Folder holding installed extensions; works in the Extension Development Host too. */
function extensionsDir(context: vscode.ExtensionContext): string | undefined {
  if (context.extensionMode === vscode.ExtensionMode.Production) return path.dirname(context.extensionUri.fsPath);
  const other = vscode.extensions.all.find((e) => !isBuiltin(e) && e.id !== context.extension.id);
  return other && path.dirname(other.extensionUri.fsPath);
}

const PROFILE_PREFIX = 'Project - ';
const DEFAULT_PROFILE = 'Default';

function profileName(): string {
  const base = vscode.workspace.name ?? path.basename(workspaceTarget());
  return `${PROFILE_PREFIX}${base.replace(/[^\w .-]/g, '').trim() || 'workspace'}`;
}

/**
 * VS Code gives a folder without its own profile the profile of the last active window and remembers it,
 * so a folder opened from a project-profile window would inherit that project's extensions.
 * `window.newWindowProfile` overrides that fallback; pointing it at Default keeps project profiles project-only.
 */
async function pinNewWindowsToDefaultProfile(): Promise<void> {
  const win = vscode.workspace.getConfiguration('window');
  if (win.inspect<string>('newWindowProfile')?.globalValue) return; // respect an explicit user choice
  await win.update('newWindowProfile', DEFAULT_PROFILE, vscode.ConfigurationTarget.Global);
  output().appendLine(`Set window.newWindowProfile to "${DEFAULT_PROFILE}" so other folders keep all extensions.`);
}

/** True while a relaunch helper started in the last few minutes may still be installing extensions. */
async function recentlyRelaunched(context: vscode.ExtensionContext): Promise<boolean> {
  try {
    const job = path.join(context.globalStorageUri.fsPath, 'relaunch-job.json');
    return Date.now() - (await fs.promises.stat(job)).mtimeMs < 3 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * The profile VS Code associates with this workspace, or undefined for the Default profile.
 * The extension API doesn't expose the window's profile (globalStorageUri always points at the default
 * profile), so this reads VS Code's own workspace -> profile associations from storage.json.
 */
let profileLookup: Promise<{ name: string; location: string } | undefined> | undefined;

function currentProfile(context: vscode.ExtensionContext): Promise<{ name: string; location: string } | undefined> {
  // A window's profile can't change without a reload, so read storage.json once per session.
  return (profileLookup ??= lookupProfile(context));
}

async function lookupProfile(context: vscode.ExtensionContext): Promise<{ name: string; location: string } | undefined> {
  const wsFile = vscode.workspace.workspaceFile;
  const uri = wsFile?.scheme === 'file' ? wsFile : vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!uri) return undefined;
  try {
    const raw = await fs.promises.readFile(path.join(userDir(context), 'globalStorage', 'storage.json'), 'utf8');
    const storage = JSON.parse(raw);
    const key = uri.toString().toLowerCase();
    const location = Object.entries<string>(storage.profileAssociations?.workspaces ?? {}).find(
      ([workspace]) => workspace.toLowerCase() === key,
    )?.[1];
    const profile = location && (storage.userDataProfiles ?? []).find((p: any) => p.location === location);
    return profile ? { name: profile.name, location: profile.location } : undefined;
  } catch {
    return undefined;
  }
}

/** Reopens this folder in another profile; VS Code then remembers that profile for this folder only. */
async function reopenInProfile(context: vscode.ExtensionContext, name: string, confirm = true): Promise<void> {
  if (confirm) {
    const ok = await vscode.window.showWarningMessage(
      `Reopen this workspace in the "${name}" profile with all your extensions? This window will close.`,
      { modal: true },
      'Continue',
    );
    if (ok !== 'Continue') return;
  }
  await launchHelper(context, { mode: 'reopen', profileName: name, disable: [], install: [] });
}

async function apply(context: vscode.ExtensionContext, mode: 'lean' | 'profile'): Promise<void> {
  const result = await analyze();
  if (result.source === 'detected') {
    const pick = await vscode.window.showWarningMessage(
      `No .vscode/${REQUIRED_FILE} found. Review the detected extensions first?`,
      { modal: true },
      'Review',
    );
    // reviewAndSave offers the apply actions itself once the file is saved.
    if (pick === 'Review') await reviewAndSave(false);
    return;
  }

  const required = result.reports.filter((r) => r.verdict === 'required').map((r) => r.id);
  const unneeded = result.reports.filter((r) => r.verdict === 'unneeded').map((r) => r.id);

  const message =
    mode === 'lean'
      ? `Reopen this workspace with ${unneeded.length} extension(s) disabled? This window will close. ` +
        'Disabling lasts for the new window only.'
      : `Open this workspace in the profile "${profileName()}" with ${required.length + result.missing.length} extension(s)? ` +
        'This window will close. VS Code remembers the profile for this folder, and your settings, keybindings and snippets are copied into it. ' +
        'Other folders keep the Default profile (window.newWindowProfile is set to "Default" unless you already chose one).';
  const ok = await vscode.window.showWarningMessage(message, { modal: true }, 'Continue');
  if (ok !== 'Continue') return;

  if (mode === 'profile') await pinNewWindowsToDefaultProfile();

  await launchHelper(context, {
    mode,
    profileName: profileName(),
    disable: unneeded,
    install: [...required, ...result.missing],
  });
}

/** Writes the job, starts the detached relauncher and closes this window. */
async function launchHelper(
  context: vscode.ExtensionContext,
  spec: Pick<Job, 'mode' | 'profileName' | 'disable' | 'install'>,
): Promise<void> {
  const target = workspaceTarget();
  await vscode.workspace.saveAll(false);

  const storage = context.globalStorageUri.fsPath;
  fs.mkdirSync(storage, { recursive: true });
  const cfgCli = vscode.workspace.getConfiguration('projectExtensions').get<string>('cliPath')?.trim();
  const job: Job = {
    ...spec,
    electron: process.execPath,
    cliJs: path.join(vscode.env.appRoot, 'out', 'cli.js'),
    cliPath: cfgCli || undefined,
    target,
    userDir: userDir(context),
    userDataDir: path.dirname(userDir(context)),
    extensionsDir: extensionsDir(context),
    selfId: context.extension.id,
    logFile: path.join(storage, 'relaunch.log'),
    delayMs: 2000,
  };
  const jobFile = path.join(storage, 'relaunch-job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));

  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const child = spawn(process.execPath, [path.join(__dirname, 'relauncher.js'), jobFile], {
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: true,
  });
  child.unref();
  output().appendLine(`Relaunch helper started (${job.mode}); log: ${job.logFile}`);

  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
