# Contributing to @aether-ai/sdk

Thanks for your interest in improving the TypeScript SDK for
[Aether](https://aetherdb.ai)! Bug reports, fixes, docs, and features are all welcome.

## Getting started

```bash
git clone https://github.com/quintessence-group/aether-sdk-typescript.git
cd aether-sdk-typescript
npm install
npm run build
```

## Development workflow

1. Fork the repo and create a topic branch off `main`.
2. Make a focused change, covered by tests.
3. Run the checks below — everything should pass.
4. Open a pull request describing the change and its motivation.

### Build, test & lint

```bash
npm run build            # tsup (ESM + CJS + types)
npm test                 # vitest
npm run lint             # tsc --noEmit
npm run check:packaging  # publint + are-the-types-wrong
```

## Guidelines

- The package ships both ESM and CJS with type definitions; keep `npm run check:packaging`
  green.
- Add or update tests for any behavior change.
- Update `README.md` for any user-facing change.
- Keep public API changes backward-compatible where possible; call out breaking changes
  clearly in the PR.

## Reporting issues

- **Bugs / features:** open a GitHub issue.
- **Security vulnerabilities:** follow [SECURITY.md](SECURITY.md) — please do not file a
  public issue.

## License

By contributing, you agree that your contributions will be licensed under the project's
[MIT License](LICENSE).
