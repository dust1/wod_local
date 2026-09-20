# Repository Guidelines

## Project Structure & Module Organization

Dependencies point inward only: `UI → application → game`. `game/` never imports React, HTTP, or SQLite.

- `src/App.jsx` is the authenticated application coordinator: it owns cross-page hero/report state and composes the current hash route, but must not contain page implementations.
- `src/pages/` contains one route-level component per visible hash URI, grouped by feature (`heroes/`, `attributes/`, `skills/`, `equipment/`, `inventory/`, `reports/`, and so on). Keep page-only state and requests in the corresponding page module.
- `src/features/` contains UI reused by multiple pages: item dialogs/tables/search, skill detail components, and report rendering components. Route modules may import features; features must not import route modules.
- `src/layout/` contains the persistent shell navigation, top bar, and right rail. `src/components/` contains small generic visual primitives. `src/api/client.js` is the shared HTTP request and `useApi` boundary.
- `src/styles.css` and `src/attributes.css` remain the shared visual rules. Split CSS by feature only when ownership is unambiguous; do not duplicate selectors across page modules.
- `game/` contains framework-independent game formulas and domain logic.
  - `game/domain/` attributes, positions, phases, skills, items, effects.
  - `game/formulas/` pure calculation functions plus `CalculationTrace`/`CalculatedNumber`.
  - `game/modifiers/` modifier kinds and the percent-chain → flat → global-percent pipeline.
  - `game/targeting/` candidate enumeration and target selection.
  - `game/engine/` unit derivation and the round state machine (`simulateBattle`).
  - `game/commands/` battle-plan model, command cursor, healing interruption.
  - `game/events/` domain event types and the Chinese report renderer.
  - `game/policies/` replaceable strategies (random, roll, rounding, initiative) and `registry.mjs`.
  - `game/replay/` deterministic envelope, hashing, and report import.
- `application/` use cases and transaction boundaries (`catalog-service`, `hero-service`, `battle-service`).
- `infrastructure/persistence/` contains runtime SQL plus `database-contract.mjs`, which validates existing databases against `docs/database-schema.json`. Runtime code never creates or migrates schema.
- `server.mjs` exposes the local HTTP API and reads the runtime database at `data/game.sqlite`.
- `scripts/` contains read-only database inspection/verification, retained set-data import, smoke checks, and build helpers.
- `gamedata/generated/` is ETL output (do not hand-edit); `gamedata/overrides/` holds human corrections that must cite evidence; `gamedata/rules/` holds the `RuleQuestion` registry.
- `public/assets/wod/` stores extracted WOD visual assets. `worker/` and `.openai/` contain hosting support.
- `tests/` contains Node test files; `docs/` contains rules, source reports, and design documentation.

## Build, Test, and Development Commands

- `npm install` installs the locked dependencies.
- `npm run db:verify` validates `data/game.sqlite` against `docs/database-schema.json`, including tables, columns, indexes, foreign keys, format version, integrity, and foreign-key consistency.
- `npm run db:inspect` prints the current database structure for review. It never updates the contract automatically.
- `npm run dev -- --host 0.0.0.0 --port 4173` starts the API and Vite development server.
- `npm run test:rules` runs formula, rule, engine, and application tests.
- `npm test` runs every `tests/*.test.mjs` file.
- `npm run test:api` boots the API in `--no-vite` mode and asserts every endpoint shape.
- `npm run build` creates the production client and hosting artifacts under `dist/`.
- `npm run test:sites` validates the generated hosting worker.

Notes for restricted environments: the test runner is invoked with `--test-isolation=none` so it does not spawn piped child processes, and `server.mjs --no-vite` serves the API only without loading esbuild.

## Database Schema Maintenance

`data/game.sqlite` and `tests/fixtures/runtime-template.sqlite` must both match `docs/database-schema.json`. A missing database or contract mismatch is a startup error; the application never creates, migrates, seeds, or repairs a database. After an approved manual schema change, increment `databaseFormatVersion`, update the JSON contract and test template, then run `npm run db:verify`, `npm test`, and `npm run test:api`. Back up and stop all writers before replacing the runtime database.

## Coding Style & Naming Conventions

Use modern ECMAScript modules and two-space indentation. Prefer small pure functions for calculations and keep I/O at application boundaries. Use `camelCase` for variables and functions, `PascalCase` for React components, and descriptive kebab-case filenames for multiword modules. Preserve stable English IDs in storage while keeping Chinese names as display data. Do not duplicate formulas in UI components. Every C/D-level rule must live behind a replaceable policy registered in `game/policies/registry.mjs` and linked to a `RuleQuestion`.

For frontend changes, preserve the dependency direction `App → pages → features/components/api`; shared feature components must not reach back into `App.jsx`. Keep existing hash route identifiers stable unless a request explicitly includes a URL migration. Reuse `ItemDetailDialog`, skill effect components, and report components instead of creating page-local copies.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name tests `*.test.mjs` and place rule tests near `tests/rules.test.mjs`. Cover formula boundaries, modifier order, rounding, deterministic replay, effect duration/delay/stacking, and database migrations. Every bug fix in game logic should include a regression test. `tests/rules.test.mjs` additionally asserts that documented A-level rules have tests and that experimental policies are registered.

## Commit & Pull Request Guidelines

No established Git history is available, so use Conventional Commit subjects such as `feat: add buff scheduler` or `fix: preserve hit-grade boundary`. Keep commits focused. Pull requests should explain behavior changes, list tests run, link relevant rule documentation or issues, and include screenshots for visible UI changes. Never commit credentials, temporary logs, the 1.9 GB source database, or generated SQLite journal files.
