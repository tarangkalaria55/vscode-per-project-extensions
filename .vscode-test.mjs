// Integration tests run inside a real VS Code, following
// https://code.visualstudio.com/api/working-with-extensions/testing-extension
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // A fixture only the tests use, so the manual sandbox can't change what they see.
  workspaceFolder: './test-fixtures/test-project',
  // Other installed extensions must not influence the results.
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
