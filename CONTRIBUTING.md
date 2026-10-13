# Contributing to PunchPilot

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

Local development requires Node.js 24.15 or newer in the Node 24 line and npm 12.2.0. The included `.nvmrc`, the package engine checks and the container build enforce the same toolchain. Dependency install scripts are disabled on purpose.

```bash
# Clone the repository
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot

# Use the expected npm version
npm install --global npm@12.2.0 --ignore-scripts --no-audit --no-fund

# Install dependencies
npm ci --ignore-scripts
npm --prefix client ci --ignore-scripts

# Copy environment config
cp .env.example .env

# Build the web UI once; the server serves it from client/dist
npm --prefix client run build

# Start the dev server (auto-reload)
npm run dev
```

Mock Mode is on in a fresh database, so you can work on the app without a freee account.

## Tests

```bash
npm test                                # server unit and integration tests
npm run test:coverage                   # server coverage
npm --prefix client run test:coverage   # client tests
npm --prefix client run build           # required before the E2E smoke test
npm run install-browsers                # installs Chromium for the E2E smoke test
npm run test:e2e                        # end-to-end smoke test
npm run lint:security                   # security lint
npm run audit:release-age               # dependency release-age check
```

To run your local changes in Docker instead of the published image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Pull Request Process

1. Fork the repo and create a feature branch from `main`.
2. Make your changes and add or update tests.
3. Run lint and tests before submitting:
   ```bash
   npm run lint:security
   npm test
   ```
4. Open a pull request against `main` and fill in the PR template. Maintainers review the change and, if accepted, include it in a future release instead of merging the pull request directly.

Some automated checks need configuration that is only available to maintainers, so they can fail on pull requests from forks. Maintainers run those checks when they review the change.

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
