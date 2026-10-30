// Integration tests run inside a real VS Code, following
// https://code.visualstudio.com/api/working-with-extensions/testing-extension
import { defineConfig } from '@vscode/test-cli';
import * as os from 'os';
import * as path from 'path';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // A fixture only the tests use, so the manual sandbox can't change what they see.
  workspaceFolder: './test-fixtures/test-project',
  launchArgs: [
    // Other installed extensions must not influence the results.
    '--disable-extensions',
    '--disable-workspace-trust',
    // The default (.vscode-test/user-data in the repo) makes VS Code's IPC socket path exceed macOS's 103-char
    // limit on CI runners with long checkout paths.
    `--user-data-dir=${path.join(os.tmpdir(), 'vsct-ppe')}`,
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
