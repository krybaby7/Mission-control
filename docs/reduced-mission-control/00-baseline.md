# P0 — Local baseline and model policy

Part of the [build specification](../reduced-mission-control-spec.md).

**Current local reconstruction, 31 October 2026:** the reviewed cloud delivery is unavailable. Follow [10 reconstruction plan](10-reconstruction-plan.md), [11 regression supplement](11-reconstruction-regressions.md) and the newest HANDOFF entries. Original requirements below remain binding. No reconstructed behavior is validated. All test/typecheck/build/OS execution and active runtime integration remain held until explicit owner clarification; command lists and older permissions below do not override that hold.

## Outcome

Establish a reproducible Linux baseline before agents change behavior. Preserve the product's model choices, including Haiku for the light tier.

**Owner:** baseline worker. **Estimate:** 1–3 hours, medium confidence. **Dependencies:** none. No other worker edits dependencies while P0 is active.

## Files

Inspect: `package.json`, `package-lock.json`, `src/render.ts`, `src/render.test.ts`, `test/modes-tiles.test.ts`, `src/config.ts`, `src/runners/index.ts`, `docs/HANDOFF.md`.

Potential modifications: `package-lock.json`; `package.json` only if a narrowly justified compatible dependency change requires it. Setup documentation and handoff changes belong to the coordinator.

## Requirements

- [ ] **B01:** Confirm Ubuntu, native Linux Node >=22.12, native Git, intended branch and a clean understanding of existing uncommitted work. Do not re-clone, reset or discard files.
- [ ] **B02:** Run the existing local check once to establish the starting state. Explain differences from 5,639 passes / 15 skips. Do not change production code to conceal an environment failure.
- [ ] **B03:** Install the browser matching the installed Playwright package into the Ubuntu user's cache if absent. The intended local command is `node node_modules/playwright-core/cli.js install chromium`. Do not use `--with-deps` or sudo. If shared libraries are missing, report their exact names and request the necessary system-install approval.
- [ ] **B04:** Run the two browser-related test files explicitly. Missing browser/library skips block a claim that browser coverage is complete. Do not install Pandoc solely to remove its optional skip; document that skip.
- [ ] **B05:** Recheck the dependency advisory with `npm audit --json` and `npm explain fast-uri`. Use the smallest compatible dependency/lockfile update supported by the actual dependency tree. No broad update, forced audit fix or major-version migration. Record the before/after affected versions and advisory outcome.
- [ ] **B06:** Run the full check after dependency changes. Confirm the native build. No commit before `npm run check` passes.
- [ ] **B07:** Keep `Config.light`, existing family assignments, ladders, allowed-model restrictions and provider version pins unchanged. Preserve light mechanical work and escalation. “GPT 6.1 Sol agents” selects development workers only.
- [ ] **B08:** Use temporary fixtures with stand-in runners for model-selection tests. Never call the installed provider CLI to prove these model IDs are accepted.

## Acceptance

| Case | Expected result |
|---|---|
| Chromium available | Browser tests execute; their actual result is recorded |
| Chromium download or required library unavailable | Exact blocker, attempted command and skipped checks are recorded; no false pass |
| Compatible advisory fix exists | Only justified dependency changes, full check/build passing |
| No compatible fix | Record the advisory and choices; do not force a broad upgrade |
| Light feature | Stand-in job selects the existing configured light model |
| Light build fails | Existing escalation behavior is retained |
| New development-agent model | Product configuration bytes/values do not change because of that choice |

## Commands

Run inside Ubuntu at the project root:

```sh
node --version
git status --short --branch
npm run check
npm audit --json
npm explain fast-uri
node node_modules/playwright-core/cli.js install chromium
./node_modules/.bin/vitest run src/render.test.ts test/modes-tiles.test.ts
npm run check
npm run build
```

The browser install is conditional on absence. The second full check is justified by the dependency/browser changes; do not repeat it without a change or unresolved failure. Audit can return nonzero when advisories exist; preserve its output and distinguish that from a failed install.

## Worker handoff

Return commands with exit codes/counts, changed files, dependency evidence and unresolved prerequisites. Do not publish, commit with an invented identity, launch the product or delete existing work. The coordinator records the result in HANDOFF.
