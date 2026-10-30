import * as assert from 'assert';
import * as vscode from 'vscode';
import { analyze, readRequiredFile, requiredFileUri, REQUIRED_FILE, selfId, writeRequiredFile } from '../analyzer';
import { HINTS } from '../hints';

// The ID comes from the manifest so the publisher is defined in one place only.
const manifest = require('../../package.json');
const SELF = `${manifest.publisher}.${manifest.name}`.toLowerCase();
const FIXTURE_IDS = ['dbaeumer.vscode-eslint', 'editorconfig.editorconfig', 'esbenp.prettier-vscode'];

function fileUri(): vscode.Uri {
  const uri = requiredFileUri();
  assert.ok(uri, 'a workspace folder is open');
  return uri;
}

suite('Per-Project Extensions', () => {
  let current: vscode.Uri;
  let original: Uint8Array;

  suiteSetup(async () => {
    current = fileUri();
    original = await vscode.workspace.fs.readFile(current);
  });

  // Tests that write files must leave the fixture exactly as they found it.
  teardown(async () => {
    await vscode.workspace.fs.writeFile(current, original);
  });

  test('activates in a workspace with .vscode/required-extensions.json', async () => {
    const ext = vscode.extensions.getExtension(SELF);
    assert.ok(ext, `${SELF} is loaded`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('registers every contributed command', async () => {
    const contributed: { command: string }[] = manifest.contributes.commands;
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const { command } of contributed) assert.ok(registered.has(command), `${command} is registered`);
  });

  test('reads the required list from the file', async () => {
    assert.ok(current.path.endsWith(`/.vscode/${REQUIRED_FILE}`));
    const file = await readRequiredFile();
    assert.deepStrictEqual(file?.required, FIXTURE_IDS);
  });

  test('derives its own ID from the running extension', () => {
    assert.strictEqual(selfId(), SELF);
  });

  test('accepts a bare array as the file content', async () => {
    await vscode.workspace.fs.writeFile(current, Buffer.from('["ms-python.python"]'));
    assert.deepStrictEqual((await readRequiredFile())?.required, ['ms-python.python']);
  });

  test('accepts comments and trailing commas', async () => {
    const jsonc = '{\n  // tools\n  "required": ["ms-python.python",],\n}';
    await vscode.workspace.fs.writeFile(current, Buffer.from(jsonc));
    assert.deepStrictEqual((await readRequiredFile())?.required, ['ms-python.python']);
  });

  test('writes a sorted, de-duplicated list and keeps keepDeclarativeExtensions', async () => {
    await vscode.workspace.fs.writeFile(current, Buffer.from('{ "required": [], "keepDeclarativeExtensions": true }'));
    await writeRequiredFile(['b.two', 'a.one', 'b.two']);
    const file = await readRequiredFile();
    assert.deepStrictEqual(file?.required, ['a.one', 'b.two']);
    assert.strictEqual(file?.keepDeclarativeExtensions, true);
  });

  test('uses the file as the source of truth and keeps itself required', async () => {
    const result = await analyze();
    assert.strictEqual(result.source, 'file');
    const self = result.reports.find((r) => r.id.toLowerCase() === SELF);
    assert.strictEqual(self?.verdict, 'required');
  });

  test('reports listed extensions that are not installed as missing', async () => {
    // Tests run with --disable-extensions, so none of the listed extensions are present.
    const result = await analyze();
    assert.deepStrictEqual([...result.missing].sort(), FIXTURE_IDS);
  });

  test('never marks built-in extensions', async () => {
    const result = await analyze();
    const builtin = vscode.extensions.all.filter((e) => e.id.startsWith('vscode.')).map((e) => e.id);
    assert.ok(builtin.length > 0, 'VS Code exposes built-in extensions');
    for (const id of builtin) assert.ok(!result.reports.some((r) => r.id === id), `${id} is not reported`);
  });

  test('hint table only contains valid extension IDs', () => {
    for (const id of Object.keys(HINTS)) assert.match(id, /^[a-z0-9-]+\.[a-z0-9.-]+$/, id);
  });
});
