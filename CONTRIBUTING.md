# Contributing to PunchPilot

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone and install
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot
npm install
cd client && npm install && cd ..

# Copy environment config
cp .env.example .env

# Start dev server (auto-reload)
npm run dev
```

## Pull Request Process

Public `main` is written only by the documented publication path. This GitHub repository is a published artifact, not the development forge. GitHub pull requests are intake for maintainers: a reviewable patch that, if accepted, is reproduced on the source forge and published through that path.

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Run lint and tests before submitting:
   ```bash
   npm run lint:security
   npm test
   ```
4. Open a GitHub pull request against `main` and fill in the PR template so maintainers can review the patch. Accepted changes are reproduced on the source forge and published through the documented publication path.

See [docs/releases.md](docs/releases.md) for how public releases are produced.

## Code Style

- Server code lives in `server/`, client in `client/`
- Use ES modules (`import`/`export`)
- Run `npm run lint:security` to catch common security issues. It enforces an
  exact baseline (`security-lint-baseline.json`); when you deliberately change
  the lint toolchain, configuration, or the warning set, regenerate the baseline
  in the same PR with `npm run lint:security:rebaseline` - see
  [docs/security-lint-baseline.md](docs/security-lint-baseline.md) for when and
  how to do that under review.

## Reporting Issues

Use [GitHub Issues](https://github.com/sky-zhang01/punchpilot/issues) to report bugs or request features. Please include steps to reproduce for bugs.

## Security

If you find a security vulnerability, please report it through [GitHub Security Advisories](https://github.com/sky-zhang01/punchpilot/security/advisories/new) instead of opening a public issue. See [SECURITY.md](SECURITY.md) for details.
