import * as path from 'path';
import * as vscode from 'vscode';
import type { Hint } from './hints';

export type Verdict = 'required' | 'unneeded';

export interface ExtensionReport {
  id: string;
  displayName: string;
  verdict: Verdict;
  reason: string;
  /** Activates on startup (`*` / `onStartupFinished`), i.e. costs resources in every window. */
  eager: boolean;
  isActive: boolean;
}

export interface AnalysisResult {
  /** Where the required list came from. */
  source: 'file' | 'detected';
  reports: ExtensionReport[];
  /** Required IDs that are not installed in this window (installed when creating a profile). */
  missing: string[];
}

export const REQUIRED_FILE = 'required-extensions.json';

export interface RequiredFile {
  /** Extension IDs this project needs. */
  required: string[];
  /** Keep code-less extensions (themes, icons, grammars, snippets). Defaults to the setting. */
  keepDeclarativeExtensions?: boolean;
}

export function requiredFileUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0];
  return root && vscode.Uri.joinPath(root.uri, '.vscode', REQUIRED_FILE);
}

/** Reads `.vscode/required-extensions.json`; accepts `{ "required": [...] }` or a bare array. */
export async function readRequiredFile(): Promise<RequiredFile | undefined> {
  const uri = requiredFileUri();
  if (!uri) return undefined;
  const json = await readJson(uri);
  if (Array.isArray(json)) return { required: json.map(String) };
  if (json && Array.isArray(json.required)) {
    return { required: json.required.map(String), keepDeclarativeExtensions: json.keepDeclarativeExtensions };
  }
  return undefined;
}

export async function writeRequiredFile(ids: string[]): Promise<vscode.Uri> {
  const uri = requiredFileUri();
  if (!uri) throw new Error('Open a folder first.');
  const existing = await readRequiredFile();
  const body: RequiredFile = { required: [...new Set(ids)].sort() };
  if (existing?.keepDeclarativeExtensions !== undefined) {
    body.keepDeclarativeExtensions = existing.keepDeclarativeExtensions;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf8'));
  return uri;
}

let selfIdCache: string | undefined;

/**
 * This extension's lower-cased ID: the installed extension whose folder contains this code.
 * Derived at runtime so the publisher is defined only in package.json.
 */
export function selfId(): string {
  if (selfIdCache === undefined) {
    const here = __dirname.toLowerCase();
    const self = vscode.extensions.all.find((e) =>
      here.startsWith(path.normalize(e.extensionUri.fsPath).toLowerCase() + path.sep),
    );
    selfIdCache = self?.id.toLowerCase() ?? '';
  }
  return selfIdCache;
}

/** Merge a string-array setting across user, workspace and folder scopes. */
export function mergedList(key: string): Set<string> {
  const cfg = vscode.workspace.getConfiguration('projectExtensions');
  const info = cfg.inspect<string[]>(key);
  const all = [
    ...(info?.globalValue ?? []),
    ...(info?.workspaceValue ?? []),
    ...(info?.workspaceFolderValue ?? []),
  ];
  return new Set(all.map((s) => s.toLowerCase()));
}

let appRoot: string | undefined;

export function isBuiltin(ext: vscode.Extension<unknown>): boolean {
  appRoot ??= path.normalize(vscode.env.appRoot).toLowerCase();
  return path.normalize(ext.extensionUri.fsPath).toLowerCase().startsWith(appRoot);
}

/** Extensions without code: themes, grammars, snippets, keymaps, language packs. */
function isDeclarative(pkg: any): boolean {
  return !pkg.main && !pkg.browser;
}

function isExtensionPack(pkg: any): boolean {
  return Array.isArray(pkg.extensionPack) && pkg.extensionPack.length > 0 && isDeclarative(pkg);
}

async function readJson(uri: vscode.Uri): Promise<any | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    // Strip comments and trailing commas so JSONC files (extensions.json) parse.
    const text = Buffer.from(bytes)
      .toString('utf8')
      .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function workspaceRecommendations(): Promise<{ wanted: Set<string>; unwanted: Set<string> }> {
  const wanted = new Set<string>();
  const unwanted = new Set<string>();
  const sources: any[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    sources.push(await readJson(vscode.Uri.joinPath(folder.uri, '.vscode', 'extensions.json')));
  }
  const wsFile = vscode.workspace.workspaceFile;
  if (wsFile && wsFile.scheme === 'file') {
    sources.push((await readJson(wsFile))?.extensions);
  }
  for (const src of sources) {
    for (const id of src?.recommendations ?? []) wanted.add(String(id).toLowerCase());
    for (const id of src?.unwantedRecommendations ?? []) unwanted.add(String(id).toLowerCase());
  }
  return { wanted, unwanted };
}

async function npmDependencies(): Promise<Set<string>> {
  const deps = new Set<string>();
  const exclude = vscode.workspace.getConfiguration('projectExtensions').get<string>('excludeGlob');
  const files = await vscode.workspace.findFiles('**/package.json', exclude, 50);
  for (const file of files) {
    const pkg = await readJson(file);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg?.[field] ?? {})) deps.add(name);
    }
  }
  return deps;
}

/** Map file extensions / file names to language IDs using every installed extension's contributions. */
function buildLanguageIndex(): { byExt: Map<string, string>; byName: Map<string, string> } {
  const byExt = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const ext of vscode.extensions.all) {
    for (const lang of ext.packageJSON?.contributes?.languages ?? []) {
      if (!lang?.id) continue;
      for (const e of lang.extensions ?? []) byExt.set(String(e).toLowerCase(), lang.id);
      for (const n of lang.filenames ?? []) byName.set(String(n).toLowerCase(), lang.id);
    }
  }
  return { byExt, byName };
}

async function detectLanguages(): Promise<Set<string>> {
  const cfg = vscode.workspace.getConfiguration('projectExtensions');
  const files = await vscode.workspace.findFiles(
    '**/*',
    cfg.get<string>('excludeGlob'),
    cfg.get<number>('maxFilesToScan', 5000),
  );
  const { byExt, byName } = buildLanguageIndex();
  const languages = new Set<string>();
  for (const file of files) {
    const base = path.basename(file.fsPath).toLowerCase();
    const byFileName = byName.get(base);
    if (byFileName) {
      languages.add(byFileName);
      continue;
    }
    // Try the longest compound extension first (".d.ts" before ".ts").
    const parts = base.split('.');
    for (let i = 1; i < parts.length; i++) {
      const lang = byExt.get('.' + parts.slice(i).join('.'));
      if (lang) {
        languages.add(lang);
        break;
      }
    }
  }
  for (const doc of vscode.workspace.textDocuments) languages.add(doc.languageId);
  return languages;
}

class GlobCache {
  private cache = new Map<string, Promise<boolean>>();
  constructor(private exclude: string | undefined) {}

  has(pattern: string): Promise<boolean> {
    let hit = this.cache.get(pattern);
    if (!hit) {
      hit = Promise.resolve(vscode.workspace.findFiles(pattern, this.exclude, 1)).then(
        (r) => r.length > 0,
        () => false,
      );
      this.cache.set(pattern, hit);
    }
    return hit;
  }

  async any(patterns: string[]): Promise<string | undefined> {
    for (const p of patterns) if (await this.has(p)) return p;
    return undefined;
  }
}

async function detectNeed(
  ext: vscode.Extension<unknown>,
  ctx: { languages: Set<string>; npmDeps: Set<string>; globs: GlobCache },
): Promise<string | undefined> {
  const id = ext.id.toLowerCase();
  const pkg = ext.packageJSON ?? {};
  const events: string[] = pkg.activationEvents ?? [];

  // Loaded on first detection only; it is never needed when required-extensions.json exists.
  const hint: Hint | undefined = (require('./hints') as typeof import('./hints')).HINTS[id];
  if (hint) {
    const lang = hint.languages?.find((l) => ctx.languages.has(l));
    if (lang) return `project contains ${lang} files`;
    const dep = hint.npmDeps?.find((d) => ctx.npmDeps.has(d));
    if (dep) return `package.json depends on ${dep}`;
    const file = hint.files && (await ctx.globs.any(hint.files));
    if (file) return `project matches ${file}`;
  }

  for (const ev of events) {
    if (ev.startsWith('onLanguage:') && ctx.languages.has(ev.slice('onLanguage:'.length))) {
      return `activates for ${ev.slice('onLanguage:'.length)}, which this project uses`;
    }
  }

  // Implicit onLanguage activation (VS Code >= 1.74) for contributed languages.
  for (const lang of pkg.contributes?.languages ?? []) {
    if (lang?.id && ctx.languages.has(lang.id)) return `provides the ${lang.id} language`;
  }

  for (const ev of events) {
    if (ev.startsWith('workspaceContains:')) {
      const pattern = ev.slice('workspaceContains:'.length);
      if (await ctx.globs.has(pattern)) return `project matches ${pattern}`;
    }
  }
  return undefined;
}


/**
 * Classifies every installed (non-builtin) extension.
 * With `.vscode/required-extensions.json` present, that file is the source of truth;
 * otherwise the project is scanned and the result is a suggestion.
 */
export async function analyze(forceDetect = false): Promise<AnalysisResult> {
  const cfg = vscode.workspace.getConfiguration('projectExtensions');
  const alwaysEnabled = mergedList('alwaysEnabled');
  const file = forceDetect ? undefined : await readRequiredFile();
  const listed = new Set((file?.required ?? []).map((s) => s.toLowerCase()));
  const keepDeclarative = file?.keepDeclarativeExtensions ?? cfg.get<boolean>('keepDeclarativeExtensions', false);

  let detectCtx: { languages: Set<string>; npmDeps: Set<string>; globs: GlobCache } | undefined;
  let recs = { wanted: new Set<string>(), unwanted: new Set<string>() };
  if (!file) {
    const [languages, npmDeps, r] = await Promise.all([detectLanguages(), npmDependencies(), workspaceRecommendations()]);
    detectCtx = { languages, npmDeps, globs: new GlobCache(cfg.get<string>('excludeGlob')) };
    recs = r;
  }

  const userExtensions = vscode.extensions.all.filter((e) => !isBuiltin(e));
  const reports = new Map<string, ExtensionReport>();

  await Promise.all(
    userExtensions.map(async (ext) => {
      const id = ext.id.toLowerCase();
      const pkg = ext.packageJSON ?? {};
      const events: string[] = pkg.activationEvents ?? [];
      const eager = !isDeclarative(pkg) && events.some((e) => e === '*' || e === 'onStartupFinished');

      let verdict: Verdict = 'unneeded';
      let reason: string;
      const need = detectCtx && !recs.unwanted.has(id) ? await detectNeed(ext, detectCtx) : undefined;

      if (id === selfId()) {
        verdict = 'required';
        reason = 'this extension';
      } else if (listed.has(id)) {
        verdict = 'required';
        reason = `listed in ${REQUIRED_FILE}`;
      } else if (alwaysEnabled.has(id)) {
        verdict = 'required';
        reason = 'listed in projectExtensions.alwaysEnabled';
      } else if (recs.wanted.has(id)) {
        verdict = 'required';
        reason = 'recommended in .vscode/extensions.json';
      } else if (need) {
        verdict = 'required';
        reason = need;
      } else if (isExtensionPack(pkg)) {
        reason = 'extension pack (its members are judged individually)';
      } else if (keepDeclarative && isDeclarative(pkg)) {
        verdict = 'required';
        reason = 'no code (theme/snippets/grammar), costs ~nothing';
      } else if (file) {
        reason = `not listed in ${REQUIRED_FILE}`;
      } else if (eager) {
        reason = 'starts in every window but nothing in this project uses it';
      } else {
        reason = 'no matching files or languages in this project';
      }

      reports.set(id, { id: ext.id, displayName: pkg.displayName || pkg.name || ext.id, verdict, reason, eager, isActive: ext.isActive });
    }),
  );

  // Dependencies of required extensions are required too (transitively).
  const byId = new Map(userExtensions.map((e) => [e.id.toLowerCase(), e]));
  const queue = [...reports.values()].filter((r) => r.verdict === 'required').map((r) => r.id.toLowerCase());
  while (queue.length) {
    const ext = byId.get(queue.pop()!);
    for (const dep of ext?.packageJSON?.extensionDependencies ?? []) {
      const r = reports.get(String(dep).toLowerCase());
      if (r && r.verdict !== 'required') {
        r.verdict = 'required';
        r.reason = `dependency of ${ext!.id}`;
        queue.push(r.id.toLowerCase());
      }
    }
  }

  const wanted = file ? listed : recs.wanted;
  const missing = [...wanted].filter((id) => !byId.has(id));

  const sorted = [...reports.values()].sort(
    (a, b) =>
      (a.verdict === b.verdict ? 0 : a.verdict === 'required' ? -1 : 1) ||
      Number(b.eager) - Number(a.eager) ||
      a.displayName.localeCompare(b.displayName),
  );
  return { source: file ? 'file' : 'detected', reports: sorted, missing };
}
