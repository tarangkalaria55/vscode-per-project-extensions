/**
 * Detached helper, run with ELECTRON_RUN_AS_NODE after the current window closes.
 * It must not import `vscode`: the extension host is gone by the time this runs.
 *
 * Usage: <electron> relauncher.js <job.json>
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Job {
  /** lean: one-off window with extensions disabled; profile: project profile; reopen: open in an existing profile. */
  mode: 'lean' | 'profile' | 'reopen';
  /** Electron binary + cli.js, used when no explicit CLI path is configured. */
  electron: string;
  cliJs: string;
  cliPath?: string;
  /** Folder or .code-workspace file to reopen. */
  target: string;
  /** lean: extension IDs to disable for the new window. */
  disable: string[];
  /** profile: name of the project profile and the extensions it should contain. */
  profileName: string;
  install: string[];
  /** `<user-data-dir>/User`, used to seed a new profile with the current settings. */
  userDir: string;
  /** Passed to every CLI call so an isolated instance (--user-data-dir/--extensions-dir) is targeted correctly. */
  userDataDir: string;
  extensionsDir?: string;
  /** This extension's ID; it may not be on the Marketplace, so it is installed separately and never removed. */
  selfId: string;
  logFile: string;
  delayMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let logFile = '';

function log(msg: string): void {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* logging must never break the relaunch */
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_)/.test(k)) env[k] = v;
  }
  return env;
}

function runCli(job: Job, cliArgs: string[]): Promise<{ code: number; out: string }> {
  const args = [
    '--user-data-dir', job.userDataDir,
    ...(job.extensionsDir ? ['--extensions-dir', job.extensionsDir] : []),
    ...cliArgs,
  ];
  return new Promise((resolve) => {
    let child;
    if (job.cliPath) {
      const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(job.cliPath);
      const q = (s: string) => (shell ? `"${s}"` : s);
      child = spawn(q(job.cliPath), args.map(q), { shell, env: cleanEnv(), windowsHide: true });
    } else {
      child = spawn(job.electron, [job.cliJs, ...args], {
        env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      });
    }
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: String(e) }));
    child.on('close', (code) => {
      log(`code ${cliArgs.join(' ')} -> ${code}\n${out.trim()}`);
      resolve({ code: code ?? -1, out });
    });
  });
}

async function profileExtensions(job: Job): Promise<string[] | undefined> {
  const { code, out } = await runCli(job, ['--list-extensions', '--profile', job.profileName]);
  if (code !== 0 || /profile .* not found/i.test(out)) return undefined;
  return out
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[\w-]+\.[\w.-]+$/.test(s));
}

function profileDir(job: Job): string | undefined {
  try {
    const storage = JSON.parse(fs.readFileSync(path.join(job.userDir, 'globalStorage', 'storage.json'), 'utf8'));
    const entry = (storage.userDataProfiles ?? []).find((p: any) => p.name === job.profileName);
    return entry && path.join(job.userDir, 'profiles', entry.location);
  } catch {
    return undefined;
  }
}

function isEmptyFile(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').trim().replace(/\s/g, '') in { '': 1, '{}': 1, '[]': 1 };
  } catch {
    return true;
  }
}

/** Copies settings/keybindings/snippets/tasks into a freshly created profile so it doesn't start blank. */
async function seedProfile(job: Job): Promise<void> {
  let dir: string | undefined;
  for (let i = 0; i < 30 && !(dir = profileDir(job)); i++) await sleep(1000);
  if (!dir) return log('profile folder not found; settings not copied');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['settings.json', 'keybindings.json', 'tasks.json']) {
    const src = path.join(job.userDir, name);
    const dst = path.join(dir, name);
    if (fs.existsSync(src) && isEmptyFile(dst)) fs.copyFileSync(src, dst);
  }
  const snippets = path.join(job.userDir, 'snippets');
  if (fs.existsSync(snippets)) fs.cpSync(snippets, path.join(dir, 'snippets'), { recursive: true, force: false });
  log(`seeded profile folder ${dir}`);
}

function readJsonArray(file: string): any[] {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * Registers this extension's existing install in the project profile's extensions.json, the same record
 * VS Code writes when installing into a profile. Used when the CLI can't fetch it from the Marketplace.
 */
function copySelfIntoProfile(job: Job): void {
  const dir = profileDir(job);
  if (!dir) return log('profile folder not found; manager not added to profile');
  const target = path.join(dir, 'extensions.json');
  const self = job.selfId.toLowerCase();
  const isSelf = (e: any) => String(e?.identifier?.id).toLowerCase() === self;

  const profilesRoot = path.join(job.userDir, 'profiles');
  const sources = [
    ...(job.extensionsDir ? [path.join(job.extensionsDir, 'extensions.json')] : []),
    ...(fs.existsSync(profilesRoot)
      ? fs.readdirSync(profilesRoot).map((p) => path.join(profilesRoot, p, 'extensions.json'))
      : []),
  ].filter((f) => f !== target);

  const entry = sources.flatMap(readJsonArray).find(isSelf);
  if (!entry) return log('no local install of the manager found (development host?); not added to profile');

  const list = readJsonArray(target);
  if (list.some(isSelf)) return;
  list.push(entry);
  fs.writeFileSync(target, JSON.stringify(list));
  log(`added manager to profile from local install ${entry.location?.fsPath ?? entry.relativeLocation}`);
}

async function runProfile(job: Job): Promise<void> {
  const existed = (await profileExtensions(job)) !== undefined;

  // Opening with --profile creates the profile (if needed) and associates it with the folder.
  await runCli(job, ['--profile', job.profileName, job.target]);

  let current: string[] | undefined;
  for (let i = 0; i < 60 && !(current = await profileExtensions(job)); i++) await sleep(1000);
  if (!current) return log('profile was never created; giving up');

  if (!existed) await seedProfile(job);

  const self = job.selfId.toLowerCase();
  const wanted = new Set(job.install.map((s) => s.toLowerCase()).filter((id) => id !== self));
  const toInstall = [...wanted].filter((id) => !current!.includes(id));
  const toRemove = current.filter((id) => !wanted.has(id) && id !== self);

  if (!current.includes(self)) {
    const { code } = await runCli(job, ['--install-extension', job.selfId, '--profile', job.profileName]);
    // Not on the Marketplace (e.g. installed from a .vsix): reuse the local install instead.
    if (code !== 0) copySelfIntoProfile(job);
  }

  if (toInstall.length) {
    await runCli(job, [...toInstall.flatMap((id) => ['--install-extension', id]), '--profile', job.profileName]);
  }
  if (toRemove.length) {
    await runCli(job, [...toRemove.flatMap((id) => ['--uninstall-extension', id]), '--profile', job.profileName]);
  }
}

async function main(): Promise<void> {
  const job: Job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  logFile = job.logFile;
  log(`start ${job.mode} for ${job.target}`);
  await sleep(job.delayMs);

  if (job.mode === 'lean') {
    await runCli(job, ['--new-window', job.target, ...job.disable.flatMap((id) => ['--disable-extension', id])]);
  } else if (job.mode === 'reopen') {
    await runCli(job, ['--profile', job.profileName, job.target]);
  } else {
    await runProfile(job);
  }
  log('done');
}

main().catch((e) => log(`failed: ${e?.stack ?? e}`));
