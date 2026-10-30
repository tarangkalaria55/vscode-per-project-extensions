/**
 * Curated hints for popular extensions whose activation events are too broad
 * (e.g. `onStartupFinished`) to infer need from the manifest alone.
 *
 * An extension is required when ANY of its hints match the workspace.
 */
export interface Hint {
  /** Glob patterns; any match in the workspace means the extension is needed. */
  files?: string[];
  /** package.json dependency names (dependencies/devDependencies). */
  npmDeps?: string[];
  /** Workspace language IDs. */
  languages?: string[];
}

export const HINTS: Record<string, Hint> = {
  'dbaeumer.vscode-eslint': {
    files: ['**/.eslintrc*', '**/eslint.config.{js,mjs,cjs,ts}'],
    npmDeps: ['eslint'],
  },
  'esbenp.prettier-vscode': {
    files: ['**/.prettierrc*', '**/prettier.config.{js,mjs,cjs}'],
    npmDeps: ['prettier'],
  },
  'stylelint.vscode-stylelint': { files: ['**/.stylelintrc*'], npmDeps: ['stylelint'] },
  'bradlc.vscode-tailwindcss': { files: ['**/tailwind.config.*'], npmDeps: ['tailwindcss'] },
  'biomejs.biome': { files: ['**/biome.json', '**/biome.jsonc'] },
  'vitest.explorer': { npmDeps: ['vitest'] },
  'orta.vscode-jest': { npmDeps: ['jest'] },
  'ms-playwright.playwright': { npmDeps: ['@playwright/test'] },
  'vue.volar': { npmDeps: ['vue'], languages: ['vue'] },
  'svelte.svelte-vscode': { npmDeps: ['svelte'], languages: ['svelte'] },
  'angular.ng-template': { npmDeps: ['@angular/core'] },
  'astro-build.astro-vscode': { npmDeps: ['astro'], languages: ['astro'] },
  'prisma.prisma': { files: ['**/*.prisma'], npmDeps: ['prisma'] },
  'graphql.vscode-graphql': { files: ['**/*.graphql', '**/*.gql'] },
  'ms-azuretools.vscode-docker': {
    files: ['**/Dockerfile*', '**/docker-compose*.{yml,yaml}', '**/compose*.{yml,yaml}'],
  },
  'ms-azuretools.vscode-containers': {
    files: ['**/Dockerfile*', '**/docker-compose*.{yml,yaml}', '**/compose*.{yml,yaml}'],
  },
  'ms-vscode-remote.remote-containers': { files: ['**/.devcontainer/**', '**/.devcontainer.json'] },
  'ms-kubernetes-tools.vscode-kubernetes-tools': { files: ['**/{k8s,kubernetes,helm,charts}/**/*.{yml,yaml}', '**/Chart.yaml'] },
  'hashicorp.terraform': { files: ['**/*.tf', '**/*.tfvars'] },
  'redhat.vscode-yaml': { languages: ['yaml'] },
  'ms-python.python': { languages: ['python'], files: ['**/requirements*.txt', '**/pyproject.toml', '**/setup.py'] },
  'ms-python.vscode-pylance': { languages: ['python'] },
  'ms-python.debugpy': { languages: ['python'] },
  'charliermarsh.ruff': { files: ['**/ruff.toml', '**/.ruff.toml'] },
  'ms-toolsai.jupyter': { files: ['**/*.ipynb'] },
  'ms-dotnettools.csharp': { files: ['**/*.csproj', '**/*.sln'], languages: ['csharp'] },
  'ms-dotnettools.csdevkit': { files: ['**/*.csproj', '**/*.sln'] },
  'ms-dotnettools.vscode-dotnet-runtime': { files: ['**/*.csproj', '**/*.fsproj', '**/*.sln'] },
  'rust-lang.rust-analyzer': { files: ['**/Cargo.toml'] },
  'golang.go': { files: ['**/go.mod'] },
  'vscjava.vscode-java-pack': { files: ['**/pom.xml', '**/build.gradle*'] },
  'redhat.java': { files: ['**/pom.xml', '**/build.gradle*'], languages: ['java'] },
  'vscjava.vscode-gradle': { files: ['**/build.gradle*', '**/settings.gradle*'] },
  'vscjava.vscode-maven': { files: ['**/pom.xml'] },
  'dart-code.flutter': { files: ['**/pubspec.yaml'] },
  'dart-code.dart-code': { files: ['**/pubspec.yaml'] },
  'ms-vscode.cmake-tools': { files: ['**/CMakeLists.txt'] },
  'ms-vscode.cpptools': { languages: ['c', 'cpp'] },
  'ms-vscode.makefile-tools': { files: ['**/Makefile'] },
  'bmewburn.vscode-intelephense-client': { languages: ['php'], files: ['**/composer.json'] },
  'shopify.ruby-lsp': { files: ['**/Gemfile'] },
  'ms-vscode.powershell': { languages: ['powershell'] },
  'timonwong.shellcheck': { languages: ['shellscript'] },
  'editorconfig.editorconfig': { files: ['**/.editorconfig'] },
  'mikestead.dotenv': { files: ['**/.env*'] },
  'davidanson.vscode-markdownlint': { files: ['**/.markdownlint*'] },
};
