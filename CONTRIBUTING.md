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

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Run lint and tests before submitting:
   ```bash
   npm run lint:security
   npm test
   ```
4. Open a PR against `main` — fill in the PR template
5. A maintainer will review and merge after approval

## Code Style

- Server code lives in `server/`, client in `client/`
- Use ES modules (`import`/`export`)
- Run `npm run lint:security` to catch common security issues

## Reporting Issues

Use [GitHub Issues](https://github.com/sky-zhang01/punchpilot/issues) to report bugs or request features. Please include steps to reproduce for bugs.

## Security

If you find a security vulnerability, please report it through [GitHub Security Advisories](https://github.com/sky-zhang01/punchpilot/security/advisories/new) instead of opening a public issue. See [SECURITY.md](SECURITY.md) for details.
