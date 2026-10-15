# Contributing

This repository is the public mirror of `@izapai/sdk`. The package is developed in
iZap's internal monorepo; each release replaces `main` here with that copy and tags
`v<version>`, which publishes to npm.

- **Issues are welcome.** Bugs, generated-client mismatches, missing endpoints.
- **Pull requests are welcome too.** We review them here, then port the change into
  the monorepo, so it reaches this repo with the next release instead of as a merge.

## Develop

Requires Node.js 20 or newer.

```bash
npm ci
npm test           # typecheck + vitest
npm run build
```
