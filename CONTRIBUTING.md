# Contributing to atomicassets-api

Thanks for your interest in contributing. This guide covers how to set up
a development environment, the conventions we follow, and what to expect
from the review process.

## Development setup

You need Node.js 22 (see `.nvmrc`) and pnpm 10+ (`corepack enable` is
enough on a recent Node install).

```sh
git clone https://github.com/atomicassets/atomicassets-api.git
cd atomicassets-api
pnpm install
```

Run the standard checks:

```sh
pnpm build         # compile TypeScript to ./build
pnpm check-types   # type-only check
pnpm test          # unit tests (mocha)
pnpm lint          # ESLint
```

For integration / end-to-end tests you will need a running Postgres and
Redis along with `config/connections.config.json` populated. See
[README.md](./README.md) for details.

## Branching and commits

- Branch from `main`. Feature branches are usually named
  `feat/short-summary`, `fix/short-summary`, `chore/short-summary`,
  etc. Anything sensible works.
- Commit messages follow the
  [Conventional Commits](https://www.conventionalcommits.org/) style.
  The first line is `type(scope): summary` (under ~72 characters) and the
  body explains the *why*. Common types in this repo: `feat`, `fix`,
  `perf`, `refactor`, `chore`, `docs`, `build`, `ci`, `test`.
- Every commit must be signed off (DCO). Add `-s` to your `git commit`
  invocation, or configure git to do it by default:
  `git config --global format.signoff true`. The CI checks for sign-off
  on every commit in a PR.

## Pull requests

- Open a PR against `main`. Keep it focused on a single concern; large
  PRs that touch many areas at once are hard to review and slow to land.
- The PR description should explain what changed and why. Link any
  related issues.
- CI runs lint, typecheck, build, and the unit test suite. The PR cannot
  merge until CI is green.
- A maintainer will review and either request changes or approve. We aim
  to respond within a few business days.
- Once approved and CI is green, a maintainer will squash-merge.

## Code style

- TypeScript with strict-ish settings (see `tsconfig.json`).
- Four-space indentation, single quotes, trailing commas where Prettier
  would put them.
- Prefer `const` over `let`; avoid `any` unless interacting with
  intentionally untyped boundaries.
- Public API changes should be reflected in the OpenAPI definitions
  under `definitions/`.

## Reporting bugs

Open a [GitHub issue](https://github.com/atomicassets/atomicassets-api/issues/new)
with:

- The chain you are running against and the contract namespace involved.
- Configuration snippets (with secrets redacted).
- A minimal reproduction or the request that produced the unexpected
  result.
- Logs from the filler or server (set `LOG_LEVEL=debug` if needed).

## Reporting security issues

Please do not file public issues for security concerns. See
[SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed
under the MIT License. See [LICENSE](./LICENSE) for the full terms.
