# CI and publishing

Set up following the official guides for
[continuous integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration) and
[publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Continuous integration

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push to `main` and on pull requests:

- runs the tests on Windows, macOS and Linux (Linux uses `xvfb-run`, because VS Code needs a display),
- builds the `.vsix` and uploads it as the `vsix` build artifact.

It has read-only access to the repository and no secrets.

## Publishing a release

Push a `v*` tag:

```sh
npm version patch          # e.g. 0.1.2 -> 0.1.3, commits and tags v0.1.3
git push --follow-tags     # the tag triggers publish.yml
```

[.github/workflows/publish.yml](.github/workflows/publish.yml) runs the tests and publishes with
**Trusted Publishing** (`vsce publish --oidc`). GitHub issues a short-lived identity token that the Marketplace
exchanges for a 15-minute credential, so no token is stored anywhere.

### One-time setup

1. Create the publisher `tarangkalaria55` at <https://marketplace.visualstudio.com/manage> (it must match
   `"publisher"` in `package.json`).
2. Open the publisher → **Trusted Publishing** → **Create**:

   | Field | Value |
   |---|---|
   | Policy name | `Release workflow` |
   | Repository owner | `tarangkalaria55` |
   | Repository | `vscode-per-project-extensions` |
   | Workflow | `publish.yml` |
   | Environment | *(empty)* |

3. For a private repository, run the workflow within 48 hours of creating the policy; the first successful run
   activates it permanently.

## Publishing from your machine

`--oidc` only works inside GitHub Actions. To publish locally instead, use a Marketplace personal access token:

1. At <https://dev.azure.com> → **User settings** → **Personal access tokens** → **New Token**, choose
   **Organization: All accessible organizations** and **Scopes: Marketplace → Manage**. Copy the token.
2. Publish:

   ```sh
   npx vsce login tarangkalaria55   # paste the token
   npm run deploy                   # vsce publish
   ```

Global PATs stop working on **December 1, 2026**; after that, publish through the GitHub workflow.

Never commit a token or paste it into a file in this repository.
