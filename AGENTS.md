# Repository Guidelines

## Conventions

- Layout: follow `references/effect/` for package and module organization; expose PascalCase modules directly from each package's `src/` and `src/index.ts`, without an additional `internal/` layer.
- TypeScript: two spaces, double quotes, no semicolons, `import type` for type-only imports, `.js` suffixes on relative imports. Follow adjacent code; no formatter or linter is configured.
- Plugins: declare deployments, routing, transforms, and HTTP APIs/handlers at router creation; no separate gateway plugin.

## Commands

Always run project commands in `devenv` (`devenv shell -- <command>`) to keep the development environment reproducible and idempotent.

- `devenv shell -- yarn install --immutable`: install from the lockfile.
- `devenv shell -- yarn check`: compile projects and validate type tests.
- `devenv shell -- yarn build`: emit output to ignored `dist/` directories.

There is no runnable router or dev server yet.

## Tests

- Add positive and negative contract cases to `type-tests/*.mts`; mark expected failures with `@ts-expect-error`.
- Run the `check` command above after contract changes. Add runtime tests when implementing behavior; no framework or coverage threshold exists yet.

## Commits & Pull Requests

- No commit history or established message convention. Use scoped, imperative subjects, e.g. `core: define routing errors`.
- PRs: describe changed contracts or behavior, link relevant issues, report `check` and `build` results.
- Update `docs/architecture.md` when router or plugin contracts change.
