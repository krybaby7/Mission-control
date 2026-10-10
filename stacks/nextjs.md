# House stack: Next.js

This document is the house stack for new apps. Architects plan within it, the initializer scaffolds it exactly, and the conventions at the end go into the app's AGENTS.md for every later agent.

## At a glance (for planning)

- **Framework:** Next.js (latest stable), App Router, TypeScript, `src/` directory, Tailwind CSS, ESLint.
- **Data:** SQLite through `better-sqlite3` and Drizzle ORM. The database file is `data/app.db` (gitignored). Migrations apply automatically when the server first touches the database.
- **Auth, only when the app needs accounts:** local email and password hashed with `bcryptjs`, and sessions stored in SQLite behind an httpOnly cookie.
- **Tests:** Vitest for unit tests in `tests/unit/`, Playwright (Chromium only) for end-to-end tests in `tests/e2e/`. Acceptance tests mostly drive the real UI, so the UI contract should name routes, headings, labels and `data-testid`s.
- **Runs locally with no setup:** one Node server, no external services and no API keys. Plan local stand-ins: show "sent" emails in the UI or the server log, simulate payments, store uploads under `data/uploads/`.

## Scaffolding (initializer)

Run every command from the repository root. Don't implement any spec features here; feature work starts after the scaffold is committed.

### 1. Create the app

The repository is empty apart from git metadata, and its directory name may not be a valid npm package name, so scaffold into a subfolder and move the files up:

```bash
npx --yes create-next-app@latest mc-scaffold --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --skip-install --yes
rm -rf mc-scaffold/.git && shopt -s dotglob && mv mc-scaffold/* . && rmdir mc-scaffold
```

Then set `"name"` in `package.json` to the app name in kebab-case.

### 2. Trim the template

- `src/app/layout.tsx`: remove the `next/font/google` imports and their class names, and set `metadata.title` to the app name. Google fonts download at build time, and builds must work offline.
- `src/app/page.tsx`: replace the template with a minimal home page whose `<h1>` is the app name.
- Delete template images in `public/` that nothing uses.
- If the template created `AGENTS.md`, replace it (step 5). Don't create `CLAUDE.md`; agents read `AGENTS.md` when it is absent. If the template made one, make its entire content `@AGENTS.md`.

### 3. Install dependencies

```bash
npm install
npm install better-sqlite3 drizzle-orm
npm install -D drizzle-kit @types/better-sqlite3 vitest @playwright/test
```

Install `bcryptjs` (it ships its own types) only when a feature needs accounts. `better-sqlite3` is a native module: npm downloads a prebuilt binary, or compiles one with python3, make and g++. If both fail, say so in your notes instead of switching databases.

**Playwright browsers:** inside the provided container (`MC_IN_CONTAINER=1`) Chromium is preinstalled, so don't run `npx playwright install`. If e2e tests then fail with "Executable doesn't exist", the installed `@playwright/test` is newer than those browsers: run `npx playwright install chromium`. Outside the container, run `npx playwright install chromium` once now.

### 4. Create these files

`package.json` scripts (keep any flags create-next-app put on `dev` and `build`):

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint .",
  "typecheck": "next typegen && tsc --noEmit",
  "test:unit": "vitest run",
  "test:e2e": "playwright test",
  "verify": "npm run lint && npm run typecheck && npm run test:unit && npm run test:e2e",
  "db:generate": "drizzle-kit generate"
}
```

`next typegen` writes the route types that `next-env.d.ts` references, so `tsc` sees the same types on a fresh checkout as after a build.

`.gitignore`: add these lines to the generated file.

```
/data/
/test-results/
/playwright-report/
/blob-report/
/playwright/.cache/
```

`eslint.config.mjs`: add `"test-results/**"` and `"playwright-report/**"` to its ignore list, and append a config object `{ files: ["tests/**"], rules: { "react-hooks/rules-of-hooks": "off" } }`. Playwright fixtures receive a callback named `use`, which that rule mistakes for a React hook.

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "sqlite", schema: "./src/db/schema.ts", out: "./drizzle" });
```

`src/db/schema.ts`:

```ts
// Drizzle table definitions. After changing them, run `npm run db:generate` and commit the new files in drizzle/.
export {};
```

`src/db/index.ts`. The database opens lazily: `next build` imports route modules in several workers at once, and opening the database at import time would run migrations concurrently.

```ts
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const MIGRATIONS_DIR = "drizzle"; // relative to the project root, which is the working directory for dev, start and tests

/** Opens a SQLite database and applies pending migrations. Tests can pass ":memory:". */
export function openDb(file: string) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  // There are no migrations until the first `npm run db:generate`.
  if (fs.existsSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"))) migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export type Db = ReturnType<typeof openDb>;

const globalForDb = globalThis as unknown as { appDb?: Db };

/** The app database (DATABASE_PATH, default data/app.db), opened on first use and reused across hot reloads. */
export function getDb(): Db {
  globalForDb.appDb ??= openDb(process.env.DATABASE_PATH ?? "data/app.db");
  return globalForDb.appDb;
}
```

`vitest.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
```

`playwright.config.ts`. The test server gets its own database file, reset at every run, and listens on port 3100 so it never collides with a dev server on 3000:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  reporter: "line",
  workers: 1,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:3100", screenshot: "on", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "rm -f data/test.db data/test.db-wal data/test.db-shm && npm run build && npm run start -- -p 3100",
    url: "http://127.0.0.1:3100",
    env: { DATABASE_PATH: "data/test.db" },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
```

`scripts/mc-test.mjs` runs specific test files. The orchestrator calls it with the feature's frozen test files:

```js
#!/usr/bin/env node
// Usage: node scripts/mc-test.mjs <test file>...
// tests/unit/**/*.test.ts run with Vitest, tests/e2e/**/*.spec.ts with Playwright; other files (helpers, fixtures) are skipped.
// Exit codes: 0 all tests passed, 1 a test failed, 2 the files can't be run as tests (missing, misnamed or none given).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const RULE = "unit tests must match tests/unit/**/*.test.ts and e2e tests tests/e2e/**/*.spec.ts";
const fail = (message) => {
  console.error(`mc-test: ${message}`);
  process.exit(2);
};
const isUnit = (f) => f.startsWith("tests/unit/") && f.endsWith(".test.ts");
const isE2e = (f) => f.startsWith("tests/e2e/") && f.endsWith(".spec.ts");
const looksLikeTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);

const files = process.argv.slice(2).map((f) => f.replaceAll("\\", "/").replace(/^\.\//, ""));
if (files.length === 0) fail("usage: node scripts/mc-test.mjs <test file>...");
const missing = files.filter((f) => !existsSync(f));
if (missing.length > 0) fail(`file not found: ${missing.join(", ")}`);
// A misnamed test would never run, here or in `npm run verify`, so it must not count as an ordinary failure.
const misnamed = files.filter((f) => looksLikeTest(f) && !isUnit(f) && !isE2e(f));
if (misnamed.length > 0) fail(`named like a test but no runner picks it up: ${misnamed.join(", ")}. Rename it: ${RULE}.`);
const unit = files.filter(isUnit);
const e2e = files.filter(isE2e);
for (const f of files) if (!isUnit(f) && !isE2e(f)) console.log(`mc-test: skipping support file ${f}`);
if (unit.length === 0 && e2e.length === 0) fail(`none of the given files is a test; ${RULE}.`);
const run = (tool, args) => spawnSync("npx", [tool, ...args], { stdio: "inherit" }).status === 0;
const unitOk = unit.length === 0 || run("vitest", ["run", ...unit]);
const e2eOk = e2e.length === 0 || run("playwright", ["test", ...e2e]);
process.exit(unitOk && e2eOk ? 0 : 1);
```

`tests/unit/db.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "@/db";

test("the database opens and answers queries", () => {
  expect(openDb(":memory:").all(sql`select 1 as ok`)).toEqual([{ ok: 1 }]);
});
```

`tests/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
```

These snippets match the current APIs as of writing. If an installed package's API differs, adapt the code to it and keep the paths, scripts and behavior.

### 5. AGENTS.md

Keep it short, like a table of contents: other agents read it at the start of every run.

```markdown
# <App name>

<One-sentence summary.>

## Commands
- `npm run dev`: development server on http://localhost:3000
- `npm run verify`: lint, typecheck, unit and e2e tests; must pass before you finish
- `node scripts/mc-test.mjs <files>`: run specific test files
- `npm run db:generate`: create a migration after changing `src/db/schema.ts`

## Layout
- `src/app/`: routes (pages, layouts, `api/**/route.ts`, server actions)
- `src/components/`: shared React components
- `src/lib/`: server logic (data access, auth)
- `src/db/`: Drizzle schema and connection (`getDb()`); `drizzle/`: generated migrations
- `tests/unit/` (Vitest, `*.test.ts`), `tests/e2e/` (Playwright, `*.spec.ts`)

## Conventions
<The conventions below, condensed to one line each.>

## Tests
- Do not edit `tests/` unless you are the test author: those files are frozen acceptance tests.
<The test conventions below, condensed.>

## UI contract
<The spec's uiContract, verbatim.>
```

### 6. Done when

- `npm run verify` exits 0 from the repository root.
- `git status --short` lists only source files: no `node_modules/`, `.next/`, `data/`, `test-results/` or `mc-scaffold/`.
- Your final answer returns this verify config:

```json
{"install":"npm install","full":"npm run verify","tests":"node scripts/mc-test.mjs {files}","testGlobs":["tests/**"]}
```

## Conventions (all agents)

- **Data:** define tables in `src/db/schema.ts`, run `npm run db:generate`, and commit the generated files in `drizzle/`. Never edit generated migrations. `drizzle-kit generate` asks interactively when it can't tell a rename from a drop and add, so add new columns instead of renaming or dropping existing ones.
- **Data access:** call `getDb()` from server code only (Server Components, Server Actions, route handlers, `src/lib/`). Write data-access functions that take the database as a parameter where unit tests need them, so tests can pass `openDb(":memory:")`.
- **Fresh data:** a page that reads the database must export `const dynamic = "force-dynamic"`; otherwise `next build` renders it once at build time and it never changes.
- **Mutations:** use Server Actions with `<form action={...}>` (they work before hydration, which keeps e2e tests stable) or route handlers under `src/app/api/`. Call `revalidatePath` after a write.
- **Request APIs:** `cookies()`, `headers()`, `params` and `searchParams` are async in current Next.js; await them.
- **Accessible UI:** every input has a visible `<label>`, buttons have visible text, and `data-testid`s come from the UI contract. Tests select by role, label and test id.
- **Auth, when needed:** a `users` table (unique lowercase email, bcrypt hash with cost 10) and a `sessions` table (random 32-byte hex id, user id, expiry). Set the `session` cookie from Server Actions or route handlers with `httpOnly: true`, `sameSite: "lax"`, `path: "/"`, and `secure` only when the request came over HTTPS; the app and its tests run on plain http, where a secure cookie is silently dropped. Protect pages in their server component or a shared layout with `redirect("/login")`. Logging out deletes the session row and the cookie.
- **Tests:** unit tests cover server logic and run in Node; anything a user does is tested through the browser in `tests/e2e/`. Name unit tests `tests/unit/**/*.test.ts` and e2e tests `tests/e2e/**/*.spec.ts`: the runners pick up nothing else, and `scripts/mc-test.mjs` rejects a test file named any other way. The e2e server is a production build on port 3100 with a fresh `data/test.db` per run, shared by all tests, so create unique data in each test and never assume an empty database. Wait for visible state with Playwright's auto-waiting assertions, never fixed sleeps. Don't leave a dev server running while you test; the e2e config starts its own.
