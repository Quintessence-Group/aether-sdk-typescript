# Releasing

This package uses [Changesets](https://github.com/changesets/changesets). You never
hand-edit the version number or `CHANGELOG.md`.

## When you make a user-facing change

Add a changeset describing it and commit the generated file with your PR:

```bash
npm run changeset
```

Pick the bump type (patch / minor / major) and write a short summary.

## Publishing (automated)

On merge to `main`, the **Release** workflow:

1. If unreleased changesets exist, opens/updates a **"Version Packages"** PR that bumps
   the version and updates `CHANGELOG.md`.
2. When that PR is merged, it publishes `@aether-ai/sdk` to npm (with provenance) and
   creates the git tag + GitHub Release.

## First publish (one-time bootstrap)

OIDC trusted publishing requires the package to already exist on npm, so the **first**
publish uses an `NPM_TOKEN` repo secret. After it succeeds:

1. Register a **Trusted Publisher** on npmjs.com → the `@aether-ai/sdk` package →
   Settings → repo `quintessence-group/aether-sdk-typescript`, workflow `release.yml`.
2. **Delete the `NPM_TOKEN` secret.** npm ≥ 11.5.1 then publishes via OIDC automatically
   (short-lived credentials, provenance built in) with no workflow change.
