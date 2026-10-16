# `mc dashboard`: implementation spec

Status: binding for the build agents. Branch `feat/ceo-dashboard`. Written against engine commit `8342744`; line numbers are from that commit. Revised once after two reviews (feasibility; legibility and scope): the places the review changed a rule are 1.8, 4.2, 4.6, 5.3, 5.6, 9, 10, 12, 17.1 and 17.2, and the decisions that still depend on the owner are in 20.2. Revised a second time at integration after four adversarial reviews of the finished build (10 major and 21 minor findings): the rules they changed are listed in section 21 from row 23 on. Revised a third time after the independent verification and the owner's decisions of the next round: the time-of-day framing was removed everywhere (the product is a team that does what the CEO asks, however long it takes), the scope words became recent and earlier, the recent window became 24 hours, and a time 6 days or more away carries its date; see section 21 from row 43 on (rows 47 to 50 are group A's).

This spec turns the design in the assessment (report sections 3 to 6) and the build brief into a contract. The data contract itself is `src/dashboard/types.ts` (the exported types of the JSON served at `GET /api/snapshot`, schemaVersion 1). Read that file first: every field there says where its value comes from. This document says how the values are built, in what order, and how they are tested.

**What the dashboard is.** The CEO's eyes only. It reads the files Mission Control already writes and shows them in plain words on a web page. It never writes, locks, creates or touches anything under the Mission Control home. The leader (a Claude session the CEO talks to) is the hands, and acts only through the existing `mc` commands. There is no authentication, by the owner's decision.

**How to read the evidence.** Everything marked "Verified" was checked against code or a fixture, with the path or `file:line`. Everything marked "Not verified" could not be checked in this session and must not be claimed to work (section 20). The evidence came from throwaway scripts that are not in the repository (a read-only proof, an `strace` run, and prototypes of the mission states, the event labels and the timeline); their results are quoted here.

Contents: 1 Verified facts · 2 Architecture · 3 Building the snapshot · 4 Vocabulary · 5 Lamp rules · 6 Source map · 7 Timeline translation table · 8 Tell the leader · 9 Needs-you cards · 10 Allowance · 11 Results (the debrief) · 12 Recent and earlier work · 13 Edge cases · 14 Fixtures · 15 Test plan · 16 File ownership · 17 What the page must do · 18 Decision-log entries · 19 Out of scope · 20 Not verified and decisions to confirm · 21 Amendments made at integration · 22 Work modes (Step 3).

---

## 1. Verified facts

### 1.1 Reading the home has no write side effect

Method. A throwaway script (not in the repository) replaced every write-capable `fs` function (`writeFileSync`, `appendFileSync`, `mkdirSync`, `rmSync`, `renameSync`, `linkSync`, `utimesSync`, `copyFileSync`, `openSync` with a write flag, and the rest) with one that records the call and throws, before loading the compiled `dist/state.js`. It then called the read methods against a copy of the capture's final home (5 missions, `usage.jsonl`, `quota.json`) plus an `mc.lock` and a `STOP` file. It hashed the whole tree (paths, sizes, mtimes, sha256) before and after. A second script ran the same reads under `strace -f -e trace=file,desc,process`.

Result.

| Call | Writes? | Evidence |
|---|---|---|
| `new MissionStore(home)` | No | `src/state.ts:84-87`: checks `isAbsolute`, stores the path. No I/O. |
| `list()` | No | `src/state.ts:143-153`: `readdirSync` plus `load`. Silently skips unreadable missions (cannot be counted from here), and rethrows any `readdir` error except ENOENT (`:290-293`). |
| `load(id)` | No | `src/state.ts:125-134`: `existsSync` plus `readJson` (`src/util/fs.ts:58-65`, a `readFileSync`). Checks only top-level types (`:303-333`). |
| `readEvents(id)` | No | `src/state.ts:179-181` through `readJsonl` (`src/util/fs.ts:104-122`): a missing file is `[]`, a torn or corrupt line is skipped. |
| `readUsage()` | No | `src/state.ts:188-192`, same `readJsonl`. |
| `activeRun()` | No | `src/state.ts:238-243`: reads `mc.lock`, `statSync` for the mtime, `process.kill(pid, 0)` (a probe, no signal), reads `/proc`. The takeover (`removeStaleLock`, `:494-502`) is only reached from `acquireLock` (`:228`). |
| `stopRequested()` | No | `src/state.ts:196-198`: `existsSync`. |
| `missionDir`, `reportPath`, `worktreesDir` | No | Pure path joins (`:155-169`). |
| `logsDir(id)` | **YES** | `src/state.ts:159-161` calls `ensureDir` (`mkdir -p`, `src/util/fs.ts:132-135`). **Never call it.** The proof script blocked it. |
| `createMission`, `save`, `appendEvent`, `appendUsage`, `requestStop`, `clearStop`, `acquireLock` | **YES** | Never call them. |

Outcome: with every write blocked, the 11 read calls above raised nothing and recorded no blocked write; the three contrast calls (`logsDir`, `requestStop`, `appendEvent`) hit `mkdirSync` and were stopped. The tree hash was identical before and after (61 entries). Under `strace` the home was touched only by `access`, `statx` and `openat(O_RDONLY)`. That proof ran on the first prototype of these reads. The reads that shipped are covered by `src/dashboard/readonly.test.ts` (T-RO-1 to T-RO-4: the tree hash, a runtime guard on every write-capable `fs` function, a static scan of the sources) and `src/dashboard/server.test.ts` (T-RO-5).

Consequence for the build.

1. The builder uses `new MissionStore(home)` and `load` for each `mission.json`, and reads everything else directly with read-only calls (`mc.lock`, `STOP`, `quota.json`, `usage.jsonl`, `events.jsonl` and a few values of `dispatch.json`). It does not use `readEvents`, `readUsage`, `stopRequested`, `missionDir` or `reportPath`. It must not call `list()` (it hides unreadable missions), `activeRun()` (see 1.2) or `logsDir()`.
2. It lists the mission folders itself with `readdirSync(<home>/missions, { withFileTypes: true })` (directories whose name does not start with ".", like `src/state.ts:287-289`) and calls `load(id)` in a `try`, so unreadable ones are counted.
3. `mc.lock`, `quota.json` and `dispatch.json` are not exposed by the store. Read them directly with `readFileSync` and `statSync`. No other `fs` function may be imported by `src/dashboard/**` except `readdirSync`, `statSync`, `existsSync`, `readFileSync`, and for the tail read `openSync` (read mode only), `readSync`, `closeSync`, `fstatSync`. A test scans the sources for the forbidden names (section 15, T-RO-2).

### 1.2 The run lock: content, heartbeat, and why `activeRun()` is not used

- Content (`src/state.ts:49-59`, written by `newLockContent`, `:401-405`): `{ pid, at, host, start? }`. `at` is an ISO time, taken when `acquireLock` ran, a moment after the engine's run function read its clock (`src/run.ts:80`, `:88`). `host` is `os.hostname()`.
- Heartbeat: the holder touches the file's mtime every `LOCK_HEARTBEAT_MS` = 60 s (`:76`, `:521-544`). A holder on another host counts as alive while the mtime is under `FOREIGN_LOCK_TTL_MS` = 5 min old (`:77`, `:461-462`).
- `activeRun()` returns only a description string ("pid 7", "pid 7 on host 3f2a"), no start time and no mtime. For a holder on the same host it probes the pid, which means nothing in another container or after a pid is reused.
- `scripts/mc-docker.sh:314` starts the run with `--hostname mission-control-run`, so the dashboard container (any other hostname) always sees a foreign holder.

Decision: the dashboard judges a run live by the **heartbeat alone** (mtime of `mc.lock` under `LOCK_STALE_MS` = 5 min, the engine's own number for foreign holders), and takes the start time from the lock's `at`. It never probes a pid. It agrees with `mc status` whenever the hosts differ, which is the Docker setup. On a bare machine where the dead holder shares the host, `mc status` notices a dead pid at once while the dashboard takes up to 5 minutes; the lamp shows amber ("the run has not reported in") first, then red. The dashboard container must not be started with `--hostname mission-control-run`.

Mid-run captures have no `mc.lock` (the capture driver's process held it in memory; the file was not copied). Tests synthesise one (section 14.3).

### 1.3 `quota.json`

Written by `QuotaGovernor.save()` (`src/quota.ts:399-413`) to `<home>/quota.json` (`src/run.ts:189`), atomically (`writeJsonAtomic`). Shape (`PersistedState`, `:109-114`):

```
{ "version": 1,
  "limits":      { "<provider>": { "kind": "session|weekly|model|spend|throttle|unknown", "until": <epoch ms>, "raw": "<provider text>", "estimated"?: true } },
  "modelBlocks": [ { "provider", "model", "until", "raw", "estimated"? } ],
  "utilization": [ { "provider": "claude|codex|mock", "window": "five_hour|seven_day|seven_day_<x>|<n>_minutes", "utilization": <0..1, may exceed 1>, "resetsAt": <epoch ms> } ] }
```

When it is written: after `recordLimit` (`:150`) and after a `recordUtilization` that changed a reading (`:199`; an identical reading returns early at `:187`, so the file is not rewritten). Not after auth failures or CLI failures (kept in memory only, `:105-108`).

What is missing, and the decisions:

| Wanted | In the file? | Decision |
|---|---|---|
| A timestamp per reading | No (`Utilization` has none, `src/types.ts:90-98`) | `fileChangedAt` = file mtime, worded "Usage figures last changed at 01:38". The engine rewrites the file only when a reading changed, so the time says when the figures last changed; a reading that was checked again later and found the same keeps the old time. Not called "as of". |
| Readings without a reset time | Not saved (`:406`) | Cannot show them. The provider shows "No usage reading yet." |
| Expired readings | The file can hold readings whose `resetsAt` has passed: pruning happens in memory (`:385-395`) and the file is only rewritten on the next change. | The builder drops readings with `resetsAt <= now` and limits with `until <= now`. |
| This run's share of the week | Memory only (`src/quota.ts:130`) | Omitted. No field in the snapshot. The debrief says so in words. |
| `raw` provider text | Yes | Never sent. Only `kind` and `until` are used. |

The authentic captures hold no usage readings: `raw/d1-limit-waiting/quota.json` and `raw/_home-final/quota.json` are `{"version":1,"limits":{"codex":{"kind":"session","raw":"mock session limit","until":1791723505596}},"modelBlocks":[],"utilization":[]}`. Window names and the 0..1 scale come from the runner parsers (`src/runners/claude.ts:336-355`, `src/runners/codex-app-server.ts:108-135`), not from a capture. Tests use a synthetic `quota.json` of this exact shape.

### 1.4 The run events and the "now" line

`src/executor.ts` writes two events per agent run:

- `run.start` (`:322`): `data = { label, jobId, role, provider, model, effort }`.
- `run.end` (`:431-444`): `data = { label, jobId, provider, model, outcome, durationMs, error? }`.

`jobId` is `<label with [^A-Za-z0-9._-] replaced by "-">-<n>` (`:359-366`), unique per mission. The log file is `<missionDir>/logs/<jobId>.ndjson`, appended while the agent streams.

`run.start` has no feature field. The feature comes from the label, set by the dispatcher: stage-level labels `onboard`, `spec`, `gate-a`, `init`, `gate-c`, `report-prose` (`src/dispatcher.ts:1037, 1096, 1143, 1184, 1252, 1917, 2053`) and per-feature labels `test-<id>` (`:1496`), `build-<id>` (`:1566`), `review-<id>` (`:1774`), `fix-<id>` (`:1803`), `diagnose-<id>` (`:1710`), `context-<id>` (`:1562`), `digest-<id>` (`:1688`).

Verified on all authentic events (with a throwaway script, not in the repository): the 79 `run.start` events of the five final missions are either one of the 6 stage-level labels or a per-feature label whose feature id exists in that mission, with none unmatched.

Cross-check source: `dispatch.json` has an `inflight` marker `{ label, feature?, optional?, at }` set for the duration of every agent run (`src/dispatcher.ts:705-716`, type `:2121-2126`). It is cleared when the run ends and carries `feature` only for non-optional feature runs (scouts omit it). The captures hold no mid-run `dispatch.json`, so the marker is a cross-check only, never the primary source.

Rule for the open run (verified by the prototype on the three mid-run fixtures): walk the mission's events in order; add each `run.start` to a map keyed by `jobId`; remove on the `run.end` with the same `jobId`; clear the whole map on `mission.start`, `mission.resume`, `mission.stopped`, `mission.failed`, `mission.end` and `run.interrupted` (the process that wrote the start is gone). The open run is the last entry left. It is used only while a run is live. Result on the fixtures: c1 → `test-add-task` (test author, feature "Add a task"), c2 → `build-add-task`, c3 → `review-add-task`; the done, partial, failed and waiting fixtures → none.

### 1.5 `dispatch.json`

Written by `Scratch` (`src/dispatcher.ts:2164-2241`). Keys: `units` (per feature: failure output, passing output, install flags), `finalVerify`, `inflight`, `interruptions`, `gitSettings`. **`gitSettings.config` is a verbatim copy of the app's `.git/config`, which can carry a push token** (`docs/mvp-spec.md`, "Git push" item 2), and `units[*].lastFailure.outputTail` holds test output with absolute paths.

The dashboard reads only these values: `finalVerify.ok`, `finalVerify.reviewed`, `finalVerify.blocking` (type `FinalCheck`, `:2153-2162`, written at `:1884`), and `inflight.label`, `inflight.feature`, `inflight.at`. It parses the file, picks those keys and drops the rest inside `read.ts`; the rest never reaches any other module. A test plants a sentinel token in `gitSettings` and asserts it is absent from the whole snapshot JSON (T-RO-4).

`finalVerify.reviewed` is absent in files written before it existed and then counts as "finished" (`:2158`). `finalVerify` is overwritten at each final check round, so it describes the last round. It is absent when the mission never reached the final check (no feature done, `:1870`), which the debrief must tell apart from "file unreadable".

### 1.6 The ladder, attempts, "recovered"

- The ladder per feature is `config.ladders.standard` or `.mechanical` by `Feature.kind` (`src/dispatcher.ts:1535-1537`). Both default ladders have 5 rungs, one of them a `diagnose` rung (`src/config.ts:55-70`). The user can change them in the config file, so the size is read from the config (`ladders.<kind>.length`), with the default when the config cannot be read.
- `Feature.attempts[]` has one entry per build attempt, diagnosis or review-fix (`src/types.ts:307-319`; recorded at `src/dispatcher.ts:653-658`). `Feature.rung` is the index of the next build step and does not count a first-try pass (it stays 0), so it is not used.
- **Steps used** = the number of attempts whose `action` is `build` or `diagnose`, at most the ladder size. A `fix` attempt is a review-fix round, not a ladder step; it is mentioned in the caption only. Verified on the fixtures: a first-try feature is 1 of 5; `signup` in the partial fixture (build fail, build fail, diagnose) is 3 of 5; a feature not yet attempted is 0 of 5. Approximate when a disputed test is diagnosed between two build rungs (`:1678-1683`): the count can then be one more than the rungs consumed, hence the cap.
- **Recovered after a retry** = `status === "done"` and some attempt has `action === "build"` and `outcome !== "pass"`. Worded "Recovered after a retry", never "tough feature": an `error` attempt can be a tooling hiccup (report section 4). No authentic fixture has it (the captures never failed then passed), so it is covered by a synthetic fixture.
- **Acceptance-test count** = `frozenTests.length`: files, not test cases. The type comment says so.

### 1.7 What is not derivable, and what was decided

| Field wanted | Derivable? | Decision |
|---|---|---|
| The stop time | No, the engine does not save it (`src/run.ts:81`, memory only; the report's gap 6). | `run.deadline` only when `mc dashboard --until HH:MM` was given and a run is live; computed with the engine's own `parseUntil(until, lock.at)`. The page says "stops at HH:MM". If the owner gives a different time than `mc run` got, it is wrong; the help text says to give the same one. Otherwise `null`, and the page omits the countdown. |
| Run start | Yes: `mc.lock` `at` (live run only). | As above. After a run ends the lock is gone, so no "ran from ... to ..." is shown. |
| This run's share of the week | No (memory only). | Omitted. The debrief allowance note says it cannot be shown. |
| Per-reading "as of" | No. | `fileChangedAt`, worded "Usage figures last changed at 01:38". |
| Structured cause of a wait | No (`WaitCause` is dropped, `src/dispatcher.ts:430` stores only `reason`). | Parsed from the shape of `reason` (`src/executor.ts:272-285`: "needs a new login" / "keeps failing (...), trying again at" / "<kind> limit until"). Anything that does not match is cause `unknown`, worded "Mission Control cannot tell why", and is amber (never green). A "needs a new login" part means one AI is blocked while the run sleeps for the other one (`src/executor.ts:243-257`, `src/quota.ts:225`); that is amber too (4.6). |
| Feature on `run.start` | No. | From the label (1.4), checked against the mission's feature ids. |
| "Tests are running now" | No (the `verify` event is written afterwards, `src/dispatcher.ts:790`). | The now line says "Running the checks on “F”" (kind `between_steps`, `exact: false`) when a run is live, no agent run is open, and a feature is in progress. |
| Who wrote a text (engine or AI) | Not stored. | By pattern: a text is `engine` only when it equals or matches a known engine string (tables in 9.2 and 9.3). **Default `ai`.** |
| First-try badge, clean-review badge | No (need new data). | Not built (out of scope). |
| Whether each feature's own review finished | Only through a note: `The review of "<title>" did not finish, so it was merged after passing its checks.` (`src/dispatcher.ts:1755`). | The final-review tick shows a caveat when such notes exist (11). Approximate: it depends on that sentence. |
| Real durations, real prose | No: every capture ran scripted AIs, runs finish in milliseconds. | Nothing in the design depends on a duration being long. |
| Whether a "waiting" mission is asleep | Not from `status` alone (1.8). | Derived from the events: asleep until a run starts after the latest `limit.wait` (4.2). |
| Whether a "done" or "partial" mission is finished | Not from `status` alone (1.8). | Only `stage === "complete"` means finished; before that it is busy (4.2). |

### 1.8 Saved statuses that do not mean what they say

The facts below are read from the code and from the authentic event order. Items 1 and 2 were also checked live against the real engine with scripted AIs (20.1); nothing here was seen with a real AI.

1. **`waiting` is not "asleep".** `MissionRun.waiting()` sets `status = "waiting"` and saves (`src/dispatcher.ts:427-431`, called through `Dispatcher.onWaiting`, `:263`). The only place that sets it back to `running` is the `finally` of `MissionRun.run()`, after `executor.exec()` returns (`:752-757`). `exec()` waits and then runs the agent inside the same call: `waitForCandidate`, `continue`, then `this.run(req, pick)` (`src/executor.ts:156-176`). So for the whole agent run that follows a wait (up to the 45-minute agent time-out, `src/config.ts:80`) `mission.json` still says `waiting` while a `run.start` is open. The authentic order is in `raw/d2-limit-then-done/events.jsonl`: `limit.wait` at 09:58:25 with `until` 12:59:10, then the next `run.start` (`gate-a`) at 12:59:10. A page that trusted the saved status would say "Waiting until 12:59" next to a Now line that says an AI is working. Rule: 4.2 (`asleep`).
2. **`done` and `partial` are not "finished" before the stage is `complete`.** `finalize()` first calls `settleStatus()`, which sets `done` or `partial` (`src/dispatcher.ts:1958`, `:1999-2005`), then removes the work copy, runs the report-prose agent (up to 45 minutes), notifies, writes `mission.end`, and only then `setStage("complete")` (`:1959-1967`). The run cap sets `partial` and the stage `finalize` in one step (`:504-513`). The engine itself decides "work left" by stage, not status (`src/run.ts:411-417`, comment "By stage, not status"). Rule: 4.2 (`savedBusy`).
3. **A saved busy mission under a live run can be a leftover.** A killed run leaves its mission `running`; the next run only notifies about it (`src/run.ts:387-398`) and works the oldest mission with work left first (`:404-407`). Until its turn comes the older mission still says `running`. Rule: 4.2 (`staleBusy`).

---

## 2. Architecture

### 2.1 Modules (all new, under `src/dashboard/`)

| File | Role | Pure? |
|---|---|---|
| `types.ts` | The contract (done). | types and constants |
| `constants.ts` | Every threshold and cap, named (5.1). | yes |
| `sanitize.ts` | `clean(text, max)`, `cleanId`. | yes |
| `vocabulary.ts` | The one vocabulary: words, sentences, clauses, templates, pattern tables, time formatting. No other module contains user-facing prose. | yes |
| `read.ts` | The only module that touches the disk: reads the home read-only, validates, whitelists, caches by size and mtime. Returns plain data (`HomeData`). | I/O (read) |
| `missions.ts` | Scope (12), mission and feature views (4), the open run and the now line (1.4, 6.1). | yes |
| `cards.ts` | Needs-you cards (9). | yes |
| `lamp.ts` | Lamp rules (5) over the facts the modules above produce. | yes |
| `timeline.ts` | Event translation (7). | yes |
| `allowance.ts` | quota rules (10). | yes |
| `debrief.ts` | Four ticks (11). | yes |
| `snapshot.ts` | `buildSnapshot` and the settings helpers; wires the modules. | yes over `HomeData` |
| `server.ts` | HTTP server, routes, headers, CSP, cache, single flight. | I/O (network) |
| `page.ts` | Locates and loads `dashboard/index.html`. | I/O (read) |
| `command.ts` | `runDashboard`: starts the server, prints the two lines, stops on a signal (2.5). Called from the `dashboard` action in `src/cli.ts`. | I/O (network) |

Co-located unit tests are `*.test.ts` next to each module (like the repo), integration tests in `test/`.

`buildSnapshot` is synchronous and never throws. Any exception inside it is caught at the top and turns into a degraded snapshot (lamp `needs_look`, reason `home_unreadable`). It takes the clock as an argument so tests are deterministic.

### 2.2 Interfaces between the modules and the other agents

```ts
// src/dashboard/snapshot.ts (agent 1)
export interface DashboardSettings {
  ladders: { standard: number; mechanical: number };            // config.ladders.<kind>.length
  pacing: { maxFiveHourUtilization: number; maxWeeklyUtilization: number };
  providers: string[];                                           // unique providers of config.families and config.light
  source: "saved" | "built_in";                                  // built_in when the config could not be read
}
export interface SnapshotOptions {
  home: string;            // absolute path of the Mission Control home
  now?: number;            // epoch ms, default Date.now()
  until?: string;          // "HH:MM", from --until
  settings?: DashboardSettings; // default builtInSettings()
  timeZone?: string;       // IANA name for every time text; default: the process time zone
  onError?: (err: unknown) => void; // called when the build failed and a degraded snapshot was returned (integration, 21)
  maxBytes?: number;       // the size the JSON must fit, default MAX_SNAPSHOT_BYTES; tests pass less to reach the smaller tries (3.2)
}
export function buildSnapshot(opts: SnapshotOptions): Snapshot;
export function settingsFromConfig(c: Pick<Config, "ladders" | "pacing" | "families" | "light">): DashboardSettings;
export function builtInSettings(): DashboardSettings;           // from defaultConfig()

// src/dashboard/server.ts (agent 2)
export interface DashboardServerOptions {
  host: string; port: number;
  pageHtml: string;                 // the contents of dashboard/index.html
  build: () => Snapshot;            // the server knows nothing about the home
  cacheMs?: number;                 // default SNAPSHOT_CACHE_MS
  healthz?: () => Record<string, unknown>;
}
export interface RunningDashboard { url: string; port: number; close(): Promise<void> }
export function startDashboardServer(o: DashboardServerOptions): Promise<RunningDashboard>;
export function contentSecurityPolicy(pageHtml: string): string; // hashes of the inline script and style
// src/dashboard/page.ts (agent 2)
export function loadPage(): string; // reads <packageRoot()>/dashboard/index.html; throws a plain-language error when missing
// src/dashboard/command.ts (agent 2)
export interface DashboardCommandOptions {
  home: string; settings: DashboardSettings;
  host: string; port: number; until?: string;
  say: (line: string) => void;      // stdout lines (2.5)
  signal?: AbortSignal;             // tests stop the server with it; the CLI wires SIGINT and SIGTERM
}
export function runDashboard(o: DashboardCommandOptions): Promise<void>;   // resolves after close; throws a plain Error on a bad port, a missing page, EADDRINUSE
```

Everything below is internal to agent 1 (nobody else needs it), written down so the work can be split along the file lines if the integrator wants two people on it (`read.ts`, `missions.ts`, `cards.ts`, `lamp.ts`, `snapshot.ts` and `vocabulary.ts` on one side; `timeline.ts`, `allowance.ts`, `debrief.ts` on the other). Any split must keep one owner per file; the second person adds their wording to `vocabulary-details.ts`, which `vocabulary.ts` re-exports.

```ts
// src/dashboard/read.ts: the only module that touches the disk. Plain, validated, cleaned data (3.2, 3.3).
export interface HomeData {
  home: "ok" | "missing" | "unreadable";           // the Mission Control folder itself
  lock: { valid: boolean; at: number | null; mtimeMs: number } | null;   // null: no mc.lock. valid: parses and pid is a positive integer
  stopRequested: boolean;
  quota: QuotaData | null;                         // null: absent, unreadable, over the cap, or not an object
  quotaMtimeMs: number | null;
  usage: UsageRecord[] | null;                     // null: ledger missing or over the cap
  missions: MissionData[];                         // readable and unreadable; folders without a mission.json are not here
  skippedFolders?: number;                         // folders beyond MAX_MISSION_FOLDERS that were not read (counted in olderMissionsHidden)
}
export interface QuotaData {                       // `raw` text is dropped inside read.ts and never leaves it
  limits: { provider: string; kind: string; until: number }[];
  modelBlocks: { provider: string; model: string; until: number }[];
  utilization: { provider: string; window: string; utilization: number; resetsAt: number }[];
}
export interface UsageRecord { missionId: string; durationMs: number }
export interface MissionData {
  folder: string;                                  // folder name, cleaned
  readable: boolean;                               // false: mission.json exists but is invalid, over the cap, or fails the deep checks
  mission: Mission | null;                         // validated; every string cleaned
  mtimeMs: number;                                 // mtime of mission.json
  events: MissionEvent[] | null;                   // oldest first; null until readDetails ran for this mission
  dispatch: DispatchPicks | "unavailable" | null;  // null until read; "unavailable": missing, unparseable or over the cap
  dispatchMtimeMs: number | null;
}
export interface DispatchPicks {                   // the only values taken from dispatch.json (1.5)
  finalVerify: { ok: boolean; reviewed: boolean | null; blocking: number | null } | null;   // null: the file has none
  inflight: { label: string; feature: string | null; at: number | null } | null;
}
export function readHome(home: string): HomeData;                                       // phase 1: lock, STOP, quota, usage, mission files
export function readDetails(home: string, data: HomeData, folders: string[]): void;     // phase 2: events and dispatch picks, only for missions in scope
export function jobLogMtime(home: string, folder: string, jobId: string): number | null; // statSync of logs/<jobId>.ndjson; never creates logs/

// src/dashboard/vocabulary.ts
export interface Formatter { time(ms: number): string; clock(ms: number): string; day(ms: number): string; ago(ms: number): string; span(ms: number): string }
export function makeFormatter(timeZone?: string): Formatter;      // "09:58", "09:58:30", "Sun 11 Oct", "12 s ago", "2 h 43 min"

// src/dashboard/missions.ts: scope, states, open run, now line. One MissionFacts per entry of missions[].
export interface MissionFacts {
  data: MissionData; view: MissionView;
  savedBusy: boolean; staleBusy: boolean;         // 4.2
  asleep: boolean; wait: (WaitInfo & { loginAis: string[] }) | null;   // 4.2, 4.6
  openRun: { jobId: string; label: string; role: string; at: number; featureId: string | null } | null;   // 1.4
  unbuilt: number;                                // u: features pending, testing, building or reviewing
  baselineBroken: boolean;
  runGone: "pending" | "gone" | null;              // saved busy with no live run: inside RUN_GONE_GRACE_MS of the last save, or past it (L2, L3, card run_stopped)
}
export type RunFacts = Pick<RunInfo, "active" | "startedAt" | "heartbeat">;   // RunInfo's line, activity and deadline come from the missions built here
export function buildMissions(d: HomeData, run: RunFacts, now: number, f: Formatter, s: DashboardSettings): MissionFacts[];
export function buildNow(m: MissionFacts[], run: RunFacts, f: Formatter, now: number): NowLine | null;   // `now` for sinceText

// src/dashboard/cards.ts
export function buildCards(m: MissionFacts[], f: Formatter): NeedsYouCard[];

// src/dashboard/lamp.ts
export interface LampInput { now: number; home: HomeData["home"]; run: RunInfo; missions: MissionFacts[]; cards: NeedsYouCard[]; counts: Counts }
export function buildLamp(i: LampInput): Lamp;

// src/dashboard/timeline.ts, allowance.ts, debrief.ts
export function buildTimeline(m: MissionFacts[], now: number, f: Formatter): Timeline;
export function buildAllowance(q: QuotaData | null, quotaMtimeMs: number | null, s: DashboardSettings, wait: WaitInfo | null, now: number, f: Formatter): Allowance;
export function buildDebrief(m: MissionFacts[], cards: NeedsYouCard[], usage: UsageRecord[] | null, f: Formatter): Debrief | null;
```

```ts
// test/dashboard-helpers.ts (agent 1; used by agents 1, 2 and 3)
export function copyHome(name: string): string;     // copies test/fixtures/dashboard/<name>/ into a fresh temp folder, returns its absolute path
export function emptyHome(): string;                // a fresh temp folder with an empty missions/ folder
export function withLock(home: string, o: { at: string; ageMs: number; now: number; pid?: number; host?: string }): void;
export function withStop(home: string): void;
export function touch(path: string, mtimeMs: number): void;
export function hashTree(dir: string): string;      // sha256 over the sorted list of "relative path, kind, size, mtimeMs, sha256 of the contents" for every file and folder
export function assertSnapshotShape(s: unknown): asserts s is Snapshot;   // throws one Error that lists every problem found; returns normally when the value is valid (T-SHAPE)
```

**First step for agent 1** (so others compile): write `snapshot.ts` with these signatures, returning a minimal valid empty snapshot, and `constants.ts` and `assertSnapshotShape` into the working tree. Do not run `git commit` (nobody commits in this build); the agents share one working tree, so a written file is visible at once. Agent 2 builds against an injected `build` function; agent 3 builds against `types.ts` and the demo path of 17.2.

### 2.3 Endpoints

| Route | Method | Response |
|---|---|---|
| `/` | GET, HEAD | The page. `200`, `text/html; charset=utf-8`. |
| `/api/snapshot` | GET, HEAD | `Snapshot` JSON. `200`, `application/json; charset=utf-8`. Built at most once per `SNAPSHOT_CACHE_MS` (1.5 s); concurrent requests share one build. |
| `/healthz` | GET, HEAD | `200` `application/json`: `{ "ok": true, "schemaVersion": 1, "settings": "saved" | "built_in", "home": "readable" | "missing" | "unreadable" }`. No snapshot build. |
| `/favicon.ico` | GET, HEAD | `204`, no body (stops browser noise). |
| anything else | GET, HEAD | `404`, `text/plain`: "Not found." |
| any other method | any | `405`, header `Allow: GET, HEAD`, `text/plain`: "This page only reads." The request body is never read. |

Routes are matched on the raw request target up to the first `?` (the query is ignored), with no normalisation, so `//x`, `/./` and `/%2e%2e/x` are 404 (amended at integration, 21: `new URL` would turn `//x` into `/` and serve the page). No file is ever opened from a request value: there is no path traversal and no directory listing because nothing is served from the disk but the one page read at start. A request target that does not start with `/`, or a request line that does not parse, gets `400`. `CONNECT` gets `405` like every other method.

Headers on every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy`:

```
default-src 'none'; script-src 'sha256-<hash of the inline script>'; style-src 'sha256-<hash of the inline style>';
connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`contentSecurityPolicy(pageHtml)` extracts the text of every `<script>` and `<style>` element and lists a SHA-256 hash for each, so no `'unsafe-inline'` is needed. Consequences for the page: no `style="..."` attributes and no `setAttribute("style", ...)` (CSP blocks them); use classes, and `element.style.width = ...` through the CSSOM (allowed) for bar widths; no inline event handler attributes; no external `src` or `href`. If the page has no inline script the hash list is empty and `script-src 'none'` is sent.

On a snapshot failure (should not happen: `buildSnapshot` does not throw) the server answers `500` `{ "error": "The snapshot could not be built." }` and writes the error to stderr once per minute.

Polling: the page asks every `POLL_INTERVAL_MS` = 4000 ms (3 to 5 s as decided; the value is sent in `freshness.pollEveryMs`). Polling, not streaming: events arrive minutes apart and iPad Safari suspends background tabs.

### 2.4 Where the page lives and how it is served

Decision: a file `dashboard/index.html` at the package root, found with `packageRoot()` (`src/prompts.ts:25-32`, the directory with `package.json`), exactly like `prompts/` and `stacks/` (`src/prompts.ts:35-49`). `loadPage()` reads it once when the server starts. If the file is missing it throws "The dashboard page file is missing (dashboard/index.html). Rebuild the image: mc build." and `mc dashboard` exits 1 before listening.

An embedded string was rejected: the page is one hand-edited HTML file owned by another agent; embedding would force escaping and a build step, and `tsc` does not copy non-TypeScript files.

Packaging consequences (agent 2):

- `package.json` `"files"`: add `"dashboard"` (now `["dist", "dashboard", "prompts", "stacks"]`). The package is private and `npm link`ed from the repo inside the image, so `files` does not change the image, but keep it correct.
- `docker/Dockerfile`: add `COPY dashboard ./dashboard` next to `COPY prompts ./prompts` and `COPY stacks ./stacks` (with the other `COPY` lines, before `RUN npm run build`). Without it the image has no page and `mc dashboard` exits 1. `.dockerignore` does not exist; nothing else changes.
- `test/docker-image.test.ts`: assert the Dockerfile contains `COPY dashboard ./dashboard`. The existing assertions (`RUN npm run build \` ... `mc --help >/dev/null`, last four lines) are unaffected.
- `dashboard/demo/*.json` and `dashboard/demo.html` (14.5, 17.2) are copied with the folder (about 80 KB of JSON and one more copy of the page that embeds it). They are harmless and unused in the container; the COPY line stays `COPY dashboard ./dashboard` so the page is always found. The owner may prefer to keep them out of the image; that would need a narrower COPY and a changed T-IMG assertion.

### 2.5 The command

`mc dashboard [--host <address>] [--port <number>] [--until <HH:MM>]`, registered in `src/cli.ts` only (agent 2).

- Where the code lives. `lenientStore(io)` (`src/cli.ts:203-211`) is a private function of `src/cli.ts`, and `src/run.ts`, `src/state.ts` and the other engine files are not edited. So the commander action is written in `src/cli.ts` (a few lines, additive): it calls `lenientStore(io)` for the home (it works when the config file has problems), reads the config in a `try` for `settingsFromConfig(loadConfig())` (falling back to `builtInSettings()`), and calls `runDashboard({ home: store.home, settings, host, port, until, say })` from `src/dashboard/command.ts`. `command.ts` never imports `src/cli.ts`.
- Description: "show the team's progress on a web page (read-only)".
- `--host` default: `0.0.0.0` inside the container (`inContainer()`, `src/config.ts:807`), else `127.0.0.1`. `--port` default `8787`, 1 to 65535, else a plain error.
- A bad `--until` gets the engine's own message from `parseUntil` (`src/run.ts:60-74`, exported); `runDashboard` validates it before anything listens (amended at integration, 21: not in the commander action). Help text: "a stop time to show: how long is left until this time (give the same time you gave mc run)".
- The config is read once at start. It is never served.
- Prints, in plain words: "Dashboard ready: http://localhost:8787" and "It only reads Mission Control's files. Press Ctrl+C to stop it." Nothing else on stdout.
- Port in use (`EADDRINUSE`): "Port 8787 is already in use. Choose another with --port." Exit 1.
- Runs until SIGINT or SIGTERM, then closes the server and exits 0. It never takes the run lock and never writes a file.
- It needs no AI login. Inside Docker it runs in a separate container (2.6).

### 2.6 Docker (agent 2: `scripts/mc-docker.sh` and `test/mc-docker.test.ts`)

New subcommand `dashboard [--port N] [--lan] [--until HH:MM]`, placed in `main()` before the `*)` case (today `dashboard` would fall into `run_mc` and get a read-write container with the logins), and listed in `usage()`.

It runs its **own** `docker run`, not `container_base` (which mounts the logins and the apps folder read-write, `scripts/mc-docker.sh:206-228`):

```
docker run --rm --init --name mission-control-dashboard
  --read-only --tmpfs /tmp:rw,size=16m
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 256m --memory-swap -1
  --volume mc-home:/home/pwuser/.mission-control:ro
  --publish 127.0.0.1:<port>:<port>         (--lan: --publish <port>:<port>)
  --env TZ=<host timezone>                  (when known, like run_container)
  --entrypoint mc mission-control:local dashboard --host 0.0.0.0 --port <port> [--until HH:MM]
```

- The `mc-home` volume is mounted **read-only** (`:ro`): the operating system enforces what the code promises. No `mc-claude`, `mc-codex`, `mc-browsers` volume and no `~/mc-apps` mount.
- `--entrypoint mc` skips `docker/entrypoint.sh`, which would print "cannot write to ~/.mission-control" for a read-only home and nag about logins (`docker/entrypoint.sh:16-38`). That file is an engine file and stays untouched.
- No `--hostname` (see 1.2). The default is `--publish 127.0.0.1:...` as `shell` does (`:392`). `--lan` publishes on every interface (anyone on the network can open it); the help says so in one line. Whether Docker Desktop on WSL2 reaches the iPad this way is **not verified** (section 20).
- Refuses a second dashboard: if `mission-control-dashboard` is already running, say the address and `docker stop mission-control-dashboard`.
- Prints before starting: "mc-docker: the dashboard is at http://localhost:<port> (Ctrl+C to stop)".
- Needs Docker and the image (`require_docker`, `require_image`); no terminal needed.

The test uses the existing fake `docker` and asserts the exact argument list, that the `mc-home` volume ends with `:ro`, that no other volume or `mc-apps` appears, `--entrypoint mc`, and the `--lan` publish variant.

### 2.7 The server never leaks the config or the files

It serves two generated documents and one static page. `config.yaml` (it holds the ntfy address, which acts like a password), `dispatch.json`, logs, reports and screenshots are not served and are not in the snapshot.

---

## 3. Building the snapshot

### 3.1 Order of work

`buildSnapshot(opts)` does these steps, each a pure function over what the previous one produced (only step 1 touches the disk):

1. **Read** (`read.ts`) → `HomeData`: lock, STOP, quota, usage, and for every mission folder either a validated mission or an "unreadable" marker. Mission files are parsed first; events and `dispatch.json` are read afterwards, only for missions that are in scope (step 3), so a home with hundreds of old missions costs one `stat` and one cached parse each.
2. **Run facts** → `RunInfo` (heartbeat class, start, running time, STOP).
3. **Scope** each mission: recent, earlier, or hidden (12). Then read the events and `dispatch.json` picks of the missions in scope only.
4. **Mission views**: `savedBusy`, `asleep`, `staleBusy`, state, words, progress, feature views (4).
5. **Open run and now line** (1.4, 6.1).
6. **Cards** (9). Features link to their card.
7. **Allowance** (10).
8. **Lamp** (5), from the facts above.
9. **Timeline** (7), from the events of recent missions.
10. **Debrief** (11).
11. **Counts, leader help, freshness.**

### 3.2 Reading rules (`read.ts`)

- Folders. A folder under `missions/` with no `mission.json` is not a mission: it is ignored and not counted. The engine's `list()` skips such folders as "half-created or corrupt" (`src/state.ts:143-153`), and `createMission` reserves the folder a moment before it writes the file (`:91-122`), so a poll in between must not flash amber. A `mission.json` that exists but cannot be used is an unreadable mission and is counted (E4).
- Never trust a type after `JSON.parse`. `MissionStore.load` checks only top-level types (`src/state.ts:303-333`). `read.ts` re-validates what the views use, with small helpers (`str`, `num`, `arr`, `rec`): `features` must be an array of objects with string `id`, `title`, `status`; `attempts` and `frozenTests` arrays (a feature with a bad array counts as 0); `decisionsNeeded` and `notes` arrays of strings (others dropped); `failure` an object or ignored; `updatedAt` a valid date, else `createdAt`. A feature with an unknown `status` has state `unknown`. A mission with an unknown `status` or `stage` has state `unknown`.
- Size caps (`constants.ts`): a `mission.json` over `MAX_MISSION_BYTES` counts as unreadable; `dispatch.json` over `MAX_DISPATCH_BYTES` counts as missing; `events.jsonl` over `MAX_EVENTS_BYTES` is read from its last `EVENTS_TAIL_BYTES` only (open read-only, `readSync` from `size - tail`, drop the first partial line); `quota.json` over `MAX_QUOTA_BYTES` counts as missing; `usage.jsonl` over `MAX_USAGE_BYTES` counts as missing (agent time becomes `null`). At most `MAX_MISSION_FOLDERS` folders are scanned, newest `mtime` first beyond the cap; `MAX_DECISIONS_SHOWN` decisions per mission are shown. What the snapshot lists is capped as follows. `MAX_MISSIONS_SHOWN` missions are listed (the ones with a red card, a failed or unknown state, an unreadable file, and the one the run is working on first; the rest keep their order). `MAX_CARDS_SHOWN` cards are listed (red first). `Counts.missionsNotShown` and `Counts.cardsNotShown` count what was cut. The lamp, the counts, the cards and the debrief's ticks and open items are made from the whole home first, so a cut never makes a red mission calm. A mission with more than `MAX_FEATURES_SHOWN` features builds its view from the stuck, left-out and unknown ones first, then those in progress, waiting and done (file order inside the list); `featuresTotal` is the real count. The whole snapshot stays under `MAX_SNAPSHOT_BYTES`: `buildSnapshot` measures its JSON and, when it is over, builds the output again with less in the lists, in this order of tries (features listed per mission / timeline lines / missions / cards): 100/60/30/50 (the normal one), 30/20/30/50, 10/8/30/50, 3/3/30/50, 1/0/30/50, 1/0/15/25, 0/0/8/12, 0/0/3/5, 0/0/1/1. A smaller try only shortens what is listed (a mission's `features`, the three lists of each `MissionDebrief`, `timeline.items`, `missions`, `needsYou`); the verdict, the ticks, the lamp and every count stay exactly what they are. A normal home fits the first try.
- Lookups by a key that came from a file (provider ids and block kinds in `quota.json`, the provider in a wait reason, a mission's stage, a window id) use `Object.hasOwn`, never `table[key]`: `constructor`, `toString`, `__proto__` and `valueOf` are ordinary unknown words. Before this, a wait reason with `constructor needs a new login` made the build throw (a degraded snapshot) or put `function Object() { [native code] }` into a sentence.
- Cache by `(path, size, mtimeMs)`: a parsed mission, its events, its `dispatch.json` picks, `usage.jsonl`. A changed key re-reads. The cache is an in-memory `Map`; it never persists anything.
- `dispatch.json`: parse, then keep only `finalVerify` (`ok` boolean, `reviewed` boolean or absent, `blocking` finite number or absent) and `inflight` (`label` string, `feature` string or absent, `at` time). Everything else is dropped in this function.
- Checkpoint fields (`mission.json` `checkpoints`, `checkpoint`, `checkpointLog`; docs/checkpoints-spec.md, 4). Read with the same re-validation: `checkpoint` must be an object with a known `kind` (`plan`, `feature`, `final`), a known `state` (`pending`, `answered`) and string `id` and `scope`, else it is dropped and the mission has no checkpoint. Kept: `id`, `scope`, `kind`, `featureId`, `round`, `state`, `parkedAt`, `look.headline`, at most `CHECKPOINT_LINES_MAX` (12) cleaned `look.lines`, `look.branch`, and `answer.decision` and `answer.at`. Dropped in `read.ts`: the owner's `note`, `reworkFrom`, `notifiedAt`, `look.commit`, `look.files` and `look.screenshots` (paths and the owner's own words never need to travel). `checkpointLog` keeps the newest `CHECKPOINT_LOG_MAX` (50) valid records without their note. `checkpoints` keeps the known kinds, once each. `plan` (docs/plans-spec.md, 7: set only when the mission was queued with `mc plan queue`) is kept only as a flag: when it is an object with an object `spec` and a string `sha256`, the cleaned mission has a `plan` whose every field is blank (`spec` empty, `sha256` and `at` empty strings); otherwise it has none. The page shows none of the plan's text, so none of it is read. The events `checkpoint.*` keep the data keys `kind`, `decision` and `feature` (never `id`, `proof`, `note`). The file `dispatch.json` is read exactly as before: the lean checkpoints have no nonce there, and nothing of it would be kept.
- `mc.lock`: `readFileSync` + `statSync`. Parse as JSON; it is a lock only when `pid` is a positive safe integer (the engine's rule, `src/state.ts:433-445`). A file that is not a lock has heartbeat `unreadable` and does not count as a run. `at` that is not a valid time gives `startedAt: null`. A negative age (mtime in the future) counts as 0.
- Time zone: all time text is made with `Intl.DateTimeFormat("en-GB", { timeZone: opts.timeZone, ... })` (verified output in Node 22: `"09:58"`, `"00:05:09"`, `"Sun 11 Oct"`; midnight prints `00:05`). In Docker the zone comes from `TZ`, which `mc-docker.sh` passes. `Formatter.when` and the other time functions return "" for a number that is not finite or lies beyond ±8.64e15 ms (`Intl` throws a `RangeError` for it).

### 3.3 Cleaning every string that came from a file

All of: mission titles, feature titles, ids, reasons, decisions, notes, stories, `limit.wait` reasons (after parsing), failure reasons, event data used in a sentence. `clean(text, max)` (`sanitize.ts`):

1. `String(text)`; replace U+2028 and U+2029 with a space.
2. Remove C0 controls except tab and newline, DEL and C1 controls (`[\x00-\x08\x0b-\x1f\x7f-\x9f]`, as `src/util/terminal.ts` does), every character of the Unicode category Cf (this takes in the bidi controls, the zero-width characters, the soft hyphen, the invisible operators U+2061-U+2064, the deprecated format characters U+206A-U+206F, the interlinear marks U+FFF9-U+FFFB and the tag characters U+E0001 and U+E0020-U+E007F), and the invisible characters that Cf leaves out: U+034F, U+115F-U+1160, U+17B4-U+17B5, U+180B-U+180F, U+3164, U+FE00-U+FE0F, U+FFA0, U+E0000-U+E007F and U+E0100-U+E01EF. Reason: tag characters spell ASCII and variation selectors carry bytes, a title written by an AI is copied into the sentence the owner pastes to the leader, and nobody can see the hidden part. A title that is only invisible characters becomes empty and falls back to the id, like any empty title.
3. Collapse every run of whitespace to one space, trim.
4. If longer than `max` code points, cut and end with "…".

Caps: titles `TITLE_MAX_CHARS` (120), ids `ID_MAX_CHARS` (80), reasons `REASON_MAX_CHARS` (400), decisions `DECISION_MAX_CHARS` (600), other notes `NOTE_MAX_CHARS` (300). The page inserts every string with `textContent` (never `innerHTML`); the server cleaning is a second line, not a substitute. The same set of characters is in the T-SHAPE check (`CONTROL` in `test/dashboard-helpers.ts`): a snapshot string that holds any of them fails the shape check.

### 3.4 Never in the snapshot

Absolute paths, hostnames, process ids, commit hashes, model names, token counts, dollars, `config.yaml` values, anything from `dispatch.json` except the whitelisted values of 3.2, the raw `reason` of a wait, the raw `raw` text of a limit, the `data` of an event that the translation table does not name. A test walks the whole snapshot JSON for `/fixture`, `/home/`, `claude-`, `gpt-`, `mc run`, a backtick, and the sentinel token (T-RO-4).

---

## 4. Vocabulary

One vocabulary, one module (`vocabulary.ts`), used by every surface. One word per idea: **feature** (never "objective" or "leg"), **Done**, **Needs you**, **Waiting**, **Paused**. "Stop" is reserved for the leader sentence "Please stop the current run." No jargon in any value that is shown (the forbidden-word list is in T-VOC): no "worktree", "branch", "frozen", "gate", "escalation", "rung", "token", "git", "builder", "test writer", "acceptance", "crash", "internal error", "mission.json".

Typography: display sentences use curly quotes “ ” around names, in the lamp, the cards, the timeline and the verdicts alike. A text that already starts with an opening curly quote or ends with a closing one is shown as it is, never with a second pair: the page does this for every AI-written line it puts in quotes (`inCurlyQuotes` in `dashboard/index.html`, used by the AI text block and by the look's lines), and the vocabulary does it for titles (`inCurlyQuotes` in `vocabulary-details.ts`). A plan card line such as “Add whisper”: As a user I can whisper therefore shows once-quoted, never ““Add whisper”: As a user I can whisper”. The ready-made "tell the leader" sentences use straight quotes `"` (they are pasted into a chat). No em dashes, no emoji.

### 4.0 Glossary: one word per idea

Every shown string uses the word in the middle column. T-VOC (15) holds the exact list of words it scans for; the right column says which ideas it protects.

| Idea | Use | Do not use |
|---|---|---|
| One piece of work in a mission | feature | objective, leg, task, unit |
| The whole job | the mission's name in curly quotes; "the app" for the software being built | project (except "the project's own checks", meaning the app's existing tests) |
| One AI | "an AI", "a second AI", "an expert AI", "a helper AI" | agent, model, builder, test writer, reviewer, engineer, architect, scout (role names) |
| All the AIs together | the AI team | the AI programs, the AIs |
| Not running, by decision, a limit or a fault | Paused (the state word, and "Paused ..." in sentences) | halted, suspended |
| Something that died or was cut short | "stopped unexpectedly", "stopped answering", "stopped working", "was stopped" (a check that took too long) | crashed, killed |
| The owner asks the run to end | "stop" only in "Please stop the current run.", "a stop was requested", "the stop time" and "Stopping cancels ..." | halt, kill, abort |
| A human is needed | "needs your help" (a failed mission, an expired login), "stuck" (a feature), "a question is waiting for you" | needs help, needs you (except the state word "Needs you" and the "Needs you" tab) |
| The last big step | "final check" for the step; "final tests" for the test run; "final review" for the AIs' read-through. The debrief tick keeps its name "Final review passed" (fixed by the brief) | gate, gate C |
| Retries | "tries" ("Tried 3 times"); the pips count "steps used"; a "reinforcement" is a try after the first | attempts, rungs, escalation, retries |
| The final check sent the team back | repair round (the debrief tick keeps its name "No rework", fixed by the brief) | repair lap, lap |
| Asleep until a limit ends | Waiting (the mission word) | Waiting for allowance as the mission word (the cause is in the sentence); "asleep" in any shown text (the login card says "The run is waiting until ...") |
| Version control | "version history", "version-control settings" | git, repository, branch, shallow clone |
| A failed run of an AI | "did not finish", "stopped working" | crashed |
| When the work happens | "now", "the current work", "recent", "earlier", "the team", "this run", "results" | any word that ties the work to a time of day (the exact stems are in the T-VOC scan, section 15; "midnight" is fine) |

"Waiting" appears in four places that mean different things and are never next to each other: the mission word (asleep until a limit ends), the feature word "Waiting its turn", the allowance pill "Waiting for reset" (from the mock-up brief), and the wait text. The queued sentence is "It starts with the next run.", not "Waiting ...".

### 4.1 Lamp

| Id | Word | Mock-up icon (page's choice) |
|---|---|---|
| `on_track` | On track | check in circle, green |
| `needs_look` | Needs a look | triangle with !, amber |
| `needs_you_now` | Needs you now | rounded square with !, red |
| `idle` | Idle | dash in circle, grey |
| `not_responding` | Not responding | broken link, grey hatched |

### 4.2 Mission (engine status, stage, live run, events → state)

Facts used by the table. `live` = `run.active` (5.2).

- `savedBusy(m)`: `status` is `running` or `waiting`; or `status` is `done` or `partial` and `stage` is not `complete` (finalize is still writing the report, or the run cap is closing the mission). Only the stage `complete` means finished (1.8).
- `asleep(m)`: `status` is `waiting`, the mission owns no open run (1.4), and either it has no `limit.wait` event at all, or its newest `limit.wait` has no `run.start` after it in the file and `generatedAt <= until + WAIT_OVER_GRACE_MS`. A `waiting` mission that does not meet this is **awake**: the agent that follows the wait is running (1.8, item 1).
- `staleBusy(m)`: `live`, `savedBusy(m)`, the mission owns no open run (1.4; an open `run.start` older than the live run's own start, the lock's `at`, was written by an earlier process and does not count as open: a killed run leaves exactly that at the end of its events), `run.startedAt` is known and `generatedAt - run.startedAt >= STALE_BUSY_AFTER_MS`, and neither `updatedAt` nor any event of the mission is at or after `run.startedAt`. It is a leftover of an earlier run that was killed, which this run has not reached yet (1.8, item 3).

Read the rows top to bottom; the first row that matches wins.

| Saved status or fact | Condition | `state` id | Word |
|---|---|---|---|
| `queued` | any | `not_started` | Not started |
| `savedBusy` | `live`, `staleBusy` | `paused` (pausedWhy `unexpected`) | Paused |
| `waiting` | `live`, `asleep` | `waiting` | Waiting |
| `savedBusy` (a `waiting` one only when it is awake) | `live` | `working` | Working |
| `savedBusy` | not `live` | `paused` (pausedWhy `unexpected`) | Paused |
| `stopped` | the mission has a `checkpoint` (`pending` or `answered`; checkpoints spec, 16) | `paused` (pausedWhy `checkpoint`) | Paused |
| `stopped` | any | `paused` (pausedWhy from the stop table, 4.5) | Paused |
| `done`, stage `complete` | any | `done` | Done |
| `partial`, stage `complete` | any | `partly_done` | Partly done |
| `failed` | any | `needs_you` | Needs you |
| anything else | any | `unknown` | Needs a look |
| mission file unreadable | any | `unknown` | Needs a look |

"Waiting" is the word whatever the cause. The cause-specific sentence is in `WaitInfo.text` (4.6). The report's table word "Waiting for allowance" is not used: the report's own design decision for Phase 1 is the neutral label "Waiting, resumes by itself" until a structured cause exists, and the cause is only known by parsing prose (1.7).

`kindWord`: `greenfield` → "new app", `feature` → "change".

### 4.3 Feature (engine status, mission state → state)

| `features[].status` | Mission state | `state` id | Word |
|---|---|---|---|
| `pending` | any | `waiting_turn` | Waiting its turn |
| `testing`, `building` | `working`, `waiting` | `being_built` | Being built |
| `reviewing` | `working`, `waiting` | `being_reviewed` | Being reviewed |
| `testing`, `building`, `reviewing` | `paused`, `needs_you`, `not_started` | `paused` | Paused |
| `testing`, `building`, `reviewing` | `done`, `partly_done`, `unknown` | `unknown` | Needs a look |
| `done` | any | `done` | Done |
| `blocked` | any | `stuck` | Stuck |
| `skipped` | any | `left_out` | Left out |
| anything else | any | `unknown` | Needs a look |

("Being built" covers writing the checks first and building, as in the report.) An in-progress feature in a finished mission cannot happen (the run cap blocks them, `src/dispatcher.ts:517-519`), so it is shown as unknown, never as work in progress.

`FeatureView.reason` for the states that have no engine reason (engine-written, so author `engine`): `paused`: "Paused. It continues on the next run."; `being_built` or `being_reviewed` in a mission that is `waiting`: "On hold until 12:59, waiting for allowance." (the time is `WaitInfo.untilText`: "Wed 15:26" when the wait ends on another day, 4.6) (`trouble`: "..., waiting for the AI team."; `login`: as `limits`; `unknown`: "On hold. Mission Control cannot tell why."); `done` with `recovered`: "Built and checked after a retry." ("Built after a retry." for a feature checked by a second AI); all other done, `waiting_turn`, `being_built`, `being_reviewed`: `null`. `stuck` and `left_out` take their reason from 9.2.

### 4.4 Progress line (mission `stage` → steps)

Words in order: Plan, Plan check, Build, Final check, Landed. The checks only advise; none is drawn as a hold or a gate.

| `stage` | Plan | Plan check | Build | Final check | Landed |
|---|---|---|---|---|---|
| `onboard`, `spec` | current | todo | todo | todo | todo |
| `gate_a` | done | current | todo | todo | todo |
| `init`, `features` | done | done | current | todo | todo |
| `gate_c` | done | done | done | current | todo |
| `finalize` | done | done | done | done | current |
| `complete` | done | done | done | done | done |
| unknown stage | todo | todo | todo | todo | todo |

A mission with state `not_started` shows every step `todo`. `repairLap` is true when `stage === "features"` and `gateCRounds > 0` (the final check sent it back, `src/dispatcher.ts:1887-1891`); the page marks Build "repair round". `progressWord` is the word of the `current` step, "Landed" when complete, "" otherwise.

### 4.5 Paused: why

Read from the mission's last `mission.stopped` event, `data.reason` (written at `src/dispatcher.ts:566` from the error message):

| `reason` matches (case-insensitive) | `pausedWhy` |
|---|---|
| `disk is almost full` or `no space left` | `disk` |
| `keep failing`, `keeps failing`, `kept refusing` | `ai_failing` |
| `deadline` | `deadline` (only the wait that would end after the stop time writes it: `src/executor.ts` `waitForCandidate`, message `no provider is free before the deadline (next chance ...)`) |
| `stop requested` | `stop_requested` (the reason of a STOP file, of a signal AND of the stop time of `mc run --until`) |
| no such event, or anything else | `unknown` |

The order of the rows is the order of the code (`stopReasonKind`): disk, then failing AIs, then deadline, then stop requested, and the first match wins (a failing AI's own error text can mention a deadline).

Verified against the real engine (a hung scripted AI, `--until 07:00`, the clock moved past 07:00): the mission is saved as `stopped` with the event `mission.stopped` reason `stop requested`, not `deadline`. `StopControl.poll()` (`src/run.ts`) aborts one controller on the STOP file, on a signal and on the deadline, and `RoleExecutor.checkStop` / `Dispatcher.checkStop` throw `StopRequestedError` (message `stop requested`) before they look at the deadline, so the `DeadlineError` branches (`src/dispatcher.ts` checkStop, `src/executor.ts` checkDeadline) are not reached in practice under the engine's run function (only by a race of microseconds between the two checks). The data therefore cannot tell a stop request from the stop time, and no text may say which it was: never "on request", never "at the planned time".

A mission that is `savedBusy` with no live run, or `staleBusy`, is `unexpected` (no event is written when a run is killed).

A mission saved as `stopped` that has a `checkpoint` is `checkpoint`, whatever its events say: the engine parks it without writing a `mission.stopped` event (the owner chose the stop; checkpoints spec, 6.1), and an answer that has not been continued yet keeps the same tag. The two cases are told apart by `checkpoint.state`: `pending` waits for the owner, `answered` continues on the next run. A checkpoint on a mission that is not `stopped` (a hand edit, or a run that already took the mission up again) is not a checkpoint.

### 4.6 Mission sentence (`MissionView.sentence`) and wait text

`k` is 1 + the position of the first feature in progress (`testing`, `building`, `reviewing`), else the number of finished features (`done`, `blocked`, `skipped`) + 1, at most `n` (the feature count). `u` = features with status `pending`, `testing`, `building` or `reviewing`.

| State | Sentence |
|---|---|
| `not_started` | It starts with the next run. |
| `working`, stage `onboard` | Reading the existing project. |
| `working`, stage `spec` | Writing the plan. |
| `working`, stage `gate_a` | Checking the plan. |
| `working`, stage `init` | Setting up the app's foundation. |
| `working`, stage `features` | Building feature `k` of `n`. (`n = 0`: Building the features.) |
| `working`, stage `gate_c` | Doing the final check of the whole app. |
| `working`, stage `finalize` | Landing the work and writing the report. |
| `waiting` | `WaitInfo.text` |
| `paused`, `deadline` | Paused: no AI would be free before the stop time. `u` of `n` features are waiting for the next run. (`u = 0`: Paused: no AI would be free before the stop time. It continues on the next run.) |
| `paused`, `stop_requested` | Paused because a stop was requested or the stop time came. `u` of `n` features are waiting for the next run. (`u = 0`: Paused because a stop was requested or the stop time came. It continues on the next run.) |
| `paused`, `disk` | Paused: the disk is almost full. |
| `paused`, `ai_failing` | Paused: the AI team kept failing. |
| `paused`, `unexpected`, not `staleBusy` | Paused: the run stopped unexpectedly. The work so far is kept and continues on the next run. |
| `paused`, `unexpected`, `staleBusy` | Paused: its earlier run stopped unexpectedly. It continues when its turn comes. |
| `paused`, `checkpoint`, `pending` | Waiting for your check of the plan. · Waiting for your check of “F”. (a feature check; `F` is the feature's title, `a feature` when the file has none) · Waiting for your check of the finished app. |
| `paused`, `checkpoint`, `answered` | You answered. It continues on the next run. |
| `paused`, `unknown` | Paused. It continues on the next run. |
| `done` | `n = 1`: The feature is built and checked. Else: All `n` features are built and checked. |
| `partly_done`, every feature done | Every feature is built, but the final check left something open. |
| `partly_done`, otherwise | `d` of `n` features are built and checked. then, as two short sentences, `s` is stuck / are stuck. and `l` was left out / were left out. (those present; e.g. "2 of 4 features are built and checked. 1 feature is stuck. 1 feature was left out.") |
| `needs_you` | It needs your help. |
| `unknown` | This page does not know this state. |
| unreadable | Its file cannot be read. |

Plurals: "1 feature", "2 features", "is" / "are", "was" / "were".

The tile of a feature under a mission that waits for a check reads Paused with the reason "Paused while the mission waits for your check." (`answered`: "Paused. It continues on the next run.").

`WaitInfo` is parsed from the mission's newest `limit.wait` event (`data.until` ISO, `data.reason`) and exists for a mission that is `asleep`. `reason` is a "; "-joined list; each part must match one of three shapes (`src/executor.ts:272-285`):

1. `<model>: <provider> needs a new login` → a login part (`provider` `claude` → "Claude", `codex` → "Codex", other → none)
2. `<model>: <provider> keeps failing (<text>), trying again at <ISO>` → trouble
3. `<model>: <kind> limit until <ISO>`, `kind` one of session, weekly, model, spend, throttle, unknown → trouble for `throttle`, else limits

If any part does not match: cause `unknown`. Else the cause is `login` when any part is a login part, else `trouble` when any part is trouble, else `limits`. **A login part means one AI is blocked and the run is sleeping for the other one**: the executor leaves a provider that needs a login out of the wake-up time (`src/executor.ts:243-257`, `src/quota.ts:225`), tries nothing before that time, and does not wake early when the login is fixed. So the text must not promise that the other AI is tried, and it needs a human. The text (provider names Claude and Codex only, never models, never the quoted failure text, never the raw string):

| Cause | `WaitInfo.text` |
|---|---|
| `limits` | Waiting for allowance until `<when>`. It resumes by itself. |
| `trouble` | Waiting for the AI team to respond until `<when>`. It resumes by itself. |
| `login` | The `limits` or `trouble` sentence above without "It resumes by itself.", then ` <Names> also needs a new login.` (`<Names>` = "Claude", "Codex" or "Claude and Codex" for those named by login parts, plural "also need"; with no recognised name: ` One AI also needs a new login.`). Example: Waiting for allowance until 12:59. Claude also needs a new login. |
| `unknown` | With a time: Waiting until `<when>`. Mission Control cannot tell why. Without one: Waiting. Mission Control cannot tell why. |

A wait of known cause always ends with "It resumes by itself." wherever it is worded (lamp, mission, Now line, banner, timeline); a login or unknown wait never does.

The time in every wait text is `data.until` (the reset plus the engine's 45 s margin), worded by the one time rule: "HH:MM" when it is on the same local day as `generatedAt`, else the weekday and the time ("Wed 15:26"), and from `DATE_FORM_AFTER_MS` (6 days) away, in either direction, the date too ("Mon 19 Oct 10:03"). A wait can last days (`src/quota.ts` allows a reset 8 days ahead, and a run with no `--until` sleeps as long as it takes), and "until 15:26" would read as later today. A weekday alone repeats every week, so a wait that ends on the Monday after next Sunday would read "Mon 10:03" and be taken for tomorrow; from 6 days away the date is part of the text. The same rule words every wait or reset time in the snapshot: `WaitInfo.untilText` (so the mission sentence, the lamp clause and sentence, the Now line, the banner, "On hold until ...", the timeline line and the login card), `AllowanceWindow.resetsText` ("resets 03:20" / "resets Thu 09:00"), the model-block note ("One kind of model is limited until Wed 15:26."), `Allowance.fileChangedText` ("Usage figures last changed at 01:38" / "... at Wed 01:38" / "... at Mon 5 Oct 01:38") and the stale-lock run line ("The last run stopped answering at 03:12." / "... at Thu 21:12."). `limitedText` keeps "Work resumes at 12:59." (same day), "Work resumes Thu 09:00." (another day) and "Work resumes Mon 19 Oct 10:03." (6 days or more away). It is implemented once, in `Formatter.when(ms, now)` (`vocabulary.ts`), with `sameDay(ms, now)` and `weekday(ms)`; the day is decided by the year, month and day, not by the weekday, and the distance is measured in elapsed time (`DATE_FORM_AFTER_MS`), so a moment 5 days 23 hours 59 minutes away is a weekday and one exactly 6 days away is a date. A time that a date cannot hold gives "" and never throws.

An `asleep` mission without a `limit.wait` event gets cause `unknown`, `until` 0 and `untilText` "". Waits are amber for the causes `login` and `unknown`, and for any wait longer than `LONG_WAIT_MS` (5.3).

---

## 5. Lamp rules

The base is report section 4. Worst state wins. A state is never colour alone. Unknown input is never green. Section 5.6 lists every place where this spec differs from the report, with the reason and what the owner can reverse.

### 5.1 Constants (`src/dashboard/constants.ts`; every threshold is named here and nowhere else)

| Constant | Value | Where it comes from |
|---|---|---|
| `POLL_INTERVAL_MS` | 4 000 | decided: 3 to 5 s |
| `PAGE_STALE_AFTER_MS` | 30 000 | report: "Not updating" after about 30 s |
| `PAGE_NOT_RESPONDING_AFTER_MS` | 300 000 | report: NOT RESPONDING after 5 min |
| `SNAPSHOT_CACHE_MS` | 1 500 | decided |
| `LOCK_FRESH_MS` | 120 000 | two missed beats of the 60 s heartbeat (`src/state.ts:76`) |
| `LOCK_STALE_MS` | 300 000 | the engine's `FOREIGN_LOCK_TTL_MS` (`src/state.ts:77`) |
| `RUN_GONE_GRACE_MS` | 60 000 | decided: a restarting run saves the mission within a minute; during the grace the lamp is amber (`run_gone_pending`), not red, so it never flashes red for one poll and never reads calm either |
| `QUIET_ACTIVITY_MS` | 3 000 000 (50 min) | longer than the 45-minute agent time-out (`src/config.ts:80`) |
| `LONG_WAIT_MS` | 3 600 000 | report: fuel will not return for over 60 min |
| `WAIT_OVER_GRACE_MS` | 120 000 | after a wait ends the next `run.start` follows within seconds; later than this a `waiting` mission with no newer `run.start` is not treated as asleep (4.2) |
| `STALE_BUSY_AFTER_MS` | 120 000 | a run that has been live this long and has not touched a saved busy mission is not working on it (4.2) |
| `WAIT_MARGIN_MS` | 45 000 | the engine's `WAIT_MARGIN_MS` (`src/executor.ts:29`, not exported, so copied). A test reads the number from that source line and compares |
| `RECENT_WINDOW_MS` | 86 400 000 (24 h) | the owner's decision: a day, longer than the 18 hours the engine allows for a stop time (`src/run.ts`) |
| `DATE_FORM_AFTER_MS` | 518 400 000 (6 days) | decided (V3): a weekday alone repeats every week, and a limit can reset up to 8 days ahead (`src/quota.ts`) |
| `PILL_GETTING_LOW` / `PILL_NEARLY_OUT` | 0.70 / 0.90 | mock-up brief |
| `TIMELINE_MAX_ITEMS` | 60 | decided |
| `TITLE_MAX_CHARS`, `ID_MAX_CHARS`, `REASON_MAX_CHARS`, `DECISION_MAX_CHARS`, `NOTE_MAX_CHARS` | 120, 80, 400, 600, 300 | decided |
| `MAX_MISSION_BYTES`, `MAX_DISPATCH_BYTES`, `MAX_EVENTS_BYTES`, `EVENTS_TAIL_BYTES`, `MAX_QUOTA_BYTES`, `MAX_USAGE_BYTES` | 8 MiB, 4 MiB, 8 MiB, 2 MiB, 1 MiB, 32 MiB | decided |
| `MAX_MISSION_FOLDERS`, `MAX_FEATURES_SHOWN`, `MAX_DECISIONS_SHOWN` | 500, 100, 50 | decided |
| `MAX_MISSIONS_SHOWN`, `MAX_CARDS_SHOWN` | 30, 50 | decided at integration (3.2): the lists are cut, the lamp and the counts still cover everything |
| `MAX_SNAPSHOT_BYTES` | 200 KiB | decided; enforced by building again with shorter lists (3.2) |
| `MAX_TIME_MS` | 8.64e15 | the latest time a JavaScript date holds; beyond it `Intl` throws |
| `MAX_UTILIZATION` | 1 000 | a utilization above this is a file in the wrong unit and is skipped (13, E8) |
| `DEFAULT_PORT` | 8787 | brief |

### 5.2 Facts the rules use

- `live` = `run.active` (heartbeat fresh or late). `late` = heartbeat age from `LOCK_FRESH_MS` up to `LOCK_STALE_MS`.
- `T` = the missions with scope `recent` (12), unreadable ones included. `B` = the missions with scope `earlier`.
- A mission is "saved busy" as defined in 4.2 (`running`, `waiting`, or `done` or `partial` before the stage is `complete`).
- `stuck` / `leftOut` = counts of features with state `stuck` / `left_out` in `T`. `questions` = cards of kind `decision` in `T` (9).
- `u` of a mission = features with status `pending`, `testing`, `building` or `reviewing`.
- A **wait** is the `WaitInfo` of a mission in `T` with state `waiting` (asleep, 4.2). `wait left` = `until - generatedAt`, at least 0.
- `lastActivityAt` and "the worked mission" are defined in the source map (6.1).

### 5.3 The decision table (ordered; every rule that fires adds a reason; the state is the worst severity)

Priority is the row order. A reason has a `code`, a severity and a clause. **A clause is one short lowercase phrase with no semicolon and no inner "and"**, with titles in curly quotes; the composer (5.4) joins clauses with "and". `n` etc. are counts. A test asserts that no clause contains ";" or " and ".

| # | Code | Severity | Fires when | Clause |
|---|---|---|---|---|
| L1 | `mission_failed` | now (red) | a mission in `T` has state `needs_you` (status `failed`; this includes an expired login) | `n = 1`: `“<title>” needs your help`; else `<n> missions need your help` |
| L2 | `run_gone` | now (red) | a mission in `T` is saved busy, and `live` is false, and `generatedAt - updatedAt >= RUN_GONE_GRACE_MS` | the run stopped unexpectedly |
| L3 | `run_gone_pending` | look (amber) | as L2, but `generatedAt - updatedAt < RUN_GONE_GRACE_MS` | checking whether the run is still going |
| L4 | `home_unreadable` | look | reading the home failed with an error other than "not found" | Mission Control's files cannot be read |
| L5 | `unreadable_mission` | look | `counts.unreadableMissions > 0` | `1 mission file cannot be read` / `<n> mission files cannot be read` |
| L6 | `unknown_state` | look | a readable mission in `T` has state `unknown`, or a feature of one has state `unknown` (an unreadable mission is already counted by L5) | something is in a state this page does not know |
| L7 | `paused_disk` | look | a mission in `T` is paused with `disk` | work paused because the disk is almost full |
| L8 | `paused_ai_failing` | look | a mission in `T` is paused with `ai_failing` | work paused because the AI team keeps failing |
| L9 | `feature_stuck` | look | `stuck > 0` (or, with `stuck = 0`, `leftOut > 0`) | `1 feature is stuck` / `<n> features are stuck` (left-out only: `1 feature was left out` / `<n> features were left out`) |
| L10 | `decision_waiting` | look | `questions > 0` | `1 question is waiting for you` / `<n> questions are waiting for you` |
| L10a | `checkpoint_waiting` | look (amber) | a mission in `T` has a `pending` checkpoint (4.2; an `answered` one raises nothing) | one mission: `“<title>” is waiting for your check`; several: `<n> checks are waiting for you` |
| L11 | `login_needed` | look | a wait of cause `login` (4.6), whatever its length | one AI needs a new login |
| L12 | `checks_failing_before` | look | a mission in `T` has `baselineBroken` | the project's own checks were already failing |
| L13 | `paused_unbuilt` | look | a mission in `T` is paused with `deadline`, `stop_requested` or `unknown` (a paused mission is not retaken by the run that paused it, `src/run.ts:404-407`) | with `U` = unbuilt features and `N` = all features of those missions that have any: `U > 0`: `<U> of <N> features are waiting for the next run`; `U = 0`: `1 mission is paused until the next run` / `<k> missions are paused until the next run` |
| L14 | `mission_partial` | look | a mission in `T` is `partly_done`, and none of L9, L10 is explained by it (no stuck or left-out feature and no question in that mission) | `“<title>” finished partly done` |
| L15 | `earlier_failed` | look | `counts.earlierNeedYou > 0` | `1 earlier mission needs your help` / `<n> earlier missions need your help` |
| L16 | `wait_unknown` | look | a wait of cause `unknown` (including an asleep mission with no `limit.wait` event) | the run is waiting for an unknown reason |
| L17 | `long_wait` | look | a wait of cause `limits` or `trouble` with `wait left > LONG_WAIT_MS` | `limits`: `waiting for allowance until <when>`; `trouble`: `waiting for the AI team until <when>` (`<when>` is the time by the rule of 4.6) |
| L18 | `heartbeat_late` | look | `run.heartbeat === "late"` | the run has not reported in for `<n>` min |
| L19 | `quiet_run` | look | heartbeat `fresh`; the worked mission has state `working`; `generatedAt - lastActivityAt >= QUIET_ACTIVITY_MS` | the run has been quiet for `<n>` min |
| L20 | `stop_requested` | look | `live` and `run.stopRequested` | a stop was requested |
| L21 | `short_wait` | info | a wait of cause `limits` or `trouble` with `wait left <= LONG_WAIT_MS` | same variants as L17 |
| L22 | `queued` | info | `T` has missions with state `not_started` | `1 mission waits for the next run` / `<n> missions wait for the next run` |
| L23 | `earlier_items` | info | `counts.earlierWaitingForYou > 0` | `1 earlier mission still waits for you` / `<n> earlier missions still wait for you` |
| L24 | `working` | ok | `live`, and no reason with severity `now` or `look` | (explains green; sentence rules 5.4) |
| L25 | `all_done` | ok | not `live`, no `now` or `look` reason, `T` has at least one mission, at least one is `done`, and every mission in `T` is `done` or `not_started` | (explains green) |
| L26 | `nothing_running` | ok | not `live`, no `now` or `look` reason, and L25 does not hold | (explains grey) |

State: any `now` → `needs_you_now`; else any `look` → `needs_look`; else L24 or L25 → `on_track`; else `idle`. `reasons` lists every rule that fired (L24 to L26 only the one that applies), in table order.

Unreadable missions are always in `T` (12), so L5 always counts them. A mission that is `staleBusy` (a leftover under a live run) is `paused`, and gives no reason until the run ends without reaching it (then L2 or L3 applies if it is still saved busy).

Every partly-done, paused, failed or unknown mission in `T` produces at least one `look` or `now` reason (L1, L2, L3, L6, L7, L8, L9, L10, L10a, L13, L14), so none of them can reach a green or grey sentence. Two exceptions: a `staleBusy` leftover (below), and a mission paused with `checkpoint` whose answer is recorded and not continued yet: it has no reason (the owner has just acted and it continues on the next run), so beside nothing else it reads as a grey lamp. Rule L13 lists its causes (`deadline`, `stop_requested`, `unknown`) and does not take in `checkpoint`: a mission that waits for a check is not "waiting for the next run".

Why amber and not red: red is for failure. A check is a stop the owner chose, nothing is broken, and waiting costs only time; the high-priority phone notice carries the urgency. Red for a check would teach the owner that red can mean fine. The one exception is a `staleBusy` leftover under a live run, which the live run will pick up in its turn.

### 5.4 The sentence

Let `clauses` be the clauses of the fired reasons with severity `now` or `look`, in order.

- **Red or amber**: `Head` = the first clause with its first letter upper-cased if it is a lowercase letter. If there is a second clause: `Head and second.` else `Head.` If there are more than two clauses add ` <m> more thing needs a look.` / ` <m> more things need a look.` (`m = clauses.length - 2`). Else if the state is amber, `live`, and every fired look reason is one of `feature_stuck`, `decision_waiting`, `checks_failing_before`, `mission_partial`, `checkpoint_waiting`, add ` The rest is on track.` Else if the one clause is `long_wait` (a wait of known cause: `limits` or `trouble`) and there is no other clause, add ` It resumes by itself.`, the same words as the mission sentence, so that amber says look, not act. With other clauses next to it the tail is left out, because "it" would not be clear.
  Examples (from the fixtures): partial fixture `1 feature is stuck.` (the architect's question is part of the stuck feature's card, so there is no separate question: 9.4); failed fixture `“Recipe box” needs your help.`; multi-mission home `“Recipe box” needs your help and 1 feature is stuck.`; a live run asleep for three hours for allowance, the one clause `waiting for allowance until 12:59`, which reads `Waiting for allowance until 12:59. It resumes by itself.`
- **Green, L24 (working)**, with `d` features done of `t` in `T` (counts in `counts`): `t = 0`: `Working on the plan.`; `t = 1`, `d = 0`: `The feature is being worked on.`; `t = 1`, `d = 1`: `The feature is done. The final steps are running.`; `d = 0`: `<t> features planned. No problems so far.`; `d < t`: `<d> of <t> features done. No problems so far.`; `d = t`: `All <t> features done. The final steps are running.` Then, if `short_wait` fired, ` Waiting for allowance until <when>. It resumes by itself.` (variant by cause: ` Waiting for the AI team to respond until <when>. It resumes by itself.`). Then the tail: ` Nothing needs you.`, or, when `earlier_items` fired (`o` = `counts.earlierWaitingForYou`), ` Nothing new needs you. <o> earlier mission(s) still wait for you (see below).`
- **Green, L25 (all done)**: one mission: `All <t> features are done.` (`t = 1`: `The feature is done.`); several: `Everything is done: <k> missions, <t> features.` Then the tail as above, then, if L22 fired, ` <q> more mission(s) wait for the next run.` (`q = 1`: ` 1 more mission waits for the next run.`)
- **Grey, L26**: `Nothing is running.` then, if L22 fired: ` <q> mission(s) wait for the next run.`; if `earlier_items` fired: ` <o> earlier mission(s) still wait for you (see below).`; if `g > 0` (earlier missions that are neither failed nor holding anything for you: `g = counts.openFromEarlier - counts.earlierNeedYou - counts.earlierWaitingForYou`): ` <g> earlier mission(s) wait for the next run (see below).`; with none of these: `Nothing is running and nothing is queued.`
- **Page side**: see 5.5.

### 5.5 What the page does on its own clock

Measured since the last successful response, on the browser's clock:

| Silence | Page shows |
|---|---|
| under `staleAfterMs` (30 s) | the server's lamp as is; "Updated hh:mm:ss" |
| `staleAfterMs` and over | `freshness.notUpdating` replaces the server's lamp unless that one is `needs_you_now` (red stays red); "Not updating" appears next to "Updated" |
| `notRespondingAfterMs` (5 min) and over | `freshness.notResponding` is the lamp; the content below is greyed (grayscale, opacity 0.95, so text keeps 4.5:1 or more in both themes); the live lines under the lamp (running time, last activity, the Now line) are not drawn, because they are frozen; nothing keeps its last colour |

The strip under the lamp (17.1) reads from the lamp that is showing, so at "Not updating" or "Not responding" a green "Nothing needs you right now." never stays on screen.

Fixed texts (vocabulary constants): `notUpdatingText` = "Not updating". `notUpdating`: state `needs_look`, word "Needs a look", sentence "Not updating. The page has had no news for a while.", reason `page_stale`. `notResponding`: state `not_responding`, word "Not responding", sentence "No news for 5 minutes. The last known state is shown greyed out.", reason `no_news`.

### 5.6 Where this resolves or departs from the report

The brief says to implement report section 4 as written. These are all the places where this spec differs, or reads the report in one of two possible ways. "Pending owner" means the contract author decided it, the build agents implement it as written here, and the owner should confirm or reverse it (also listed in 20.2). "Restore" says what to change to go back to the report's rule.

| # | Report section 4 says | This spec | Status |
|---|---|---|---|
| 1 | Recent work = missions updated since the live run's lock `at`; with no live run, the last 18 h. | Recent work = the last 24 h (`RECENT_WINDOW_MS`) always (the owner replaced the 18 hours of the first version); the lock's `at` is used only for the running time. Reason: a restart in the middle of a run (an out-of-memory kill, a Docker restart, a second `mc run` at 03:10) takes a new lock and would move everything finished earlier in that run, with its cards and timeline, out of the recent work while the new run is live. | Departure, accepted by the owner (the window is 24 h). Restore: `recentStart = run.startedAt` while live (12.1). |
| 2 | Earlier unresolved items: quiet row, "capped at amber". | Three cases (12.2). An **earlier failed** mission is amber (L15) and has a card, because the engine still treats it as open and lists it in every run summary even when it did not run in that run (`src/run.ts:42`, `:420-422`). A **finished** mission's leftover decision, stuck feature or failed baseline is a quiet row plus the info reason L23 and never changes the colour, because the engine never clears them and the lamp would be amber for ever. An earlier **queued, paused or interrupted** mission is a quiet row only (the next run takes it). Unreadable missions are always recent. | Departure for finished missions, pending owner. Restore: let L23 be `look`. |
| 3 | Amber: "a mission is paused or not started with features unbuilt and no live run". | Paused (`stopped`) missions are amber (L13). A queued mission has no features yet (`createMission` writes `features: []`, `src/state.ts:108`) and is a normal wait for the next run: grey, info L22. Otherwise a mission queued in the afternoon would turn the lamp amber until the next run. | Reading of the report, pending owner. Restore: make L22 `look`. |
| 4 | Amber when fuel will not return for over 60 minutes. | Same (L17). A shorter wait with a known cause is green, info (L21). A wait of unknown cause or with a login problem is amber whatever its length (L11, L16), because unknown is never green (brief item 10). A wait cannot run past `--until` (the executor throws first, `src/executor.ts:254`). | Follows the report, stricter for unknown. |
| 5 | (not listed) | A requested stop is amber (L20), so a run that is stopping does not read "On track". A leftover `STOP` file with no live run is not a reason (the next run clears it, `src/run.ts:91`). | Addition, pending owner. |
| 6 | A stale page is amber at 30 s. | Same, and it never downgrades red (5.5). | Follows the report. |
| 7 | Red: no heartbeat for over 5 minutes with a mission saved busy. | Same (L2). For the first `RUN_GONE_GRACE_MS` after the mission was last saved, amber `run_gone_pending` (L3) instead of calm grey. Liveness is the heartbeat alone (1.2); heartbeat bands: fresh under 2 min, late 2 to 5 min (amber, L18), stale 5 min and over. | Follows the report, one addition (L3). |
| 8 | "Last activity" has three sources. | Four: the fourth, the `dispatch.json` mtime, is rewritten around every agent run (`src/dispatcher.ts:705-716`). | Addition. |
| 9 | Mission word table: "Waiting for allowance". The same report's design decisions: "Wait cause in Phase 1: neutral label 'Waiting, resumes by itself'". | "Waiting" for any cause (4.2); the cause is in the sentence. | Resolves a contradiction inside the report. |
| 10 | The final review tick is "withheld with a caveat" when a feature's own review did not finish. | The tick keeps its state and gets a caveat (11). The final review is a different fact from a feature's own review. | Departure, pending owner. Restore: set the tick to `unknown` when the caveat applies. |
| 11 | `mission_partial` (amber when a mission is partly done). | Fires only when nothing else in that mission already explains it (L14), so one fact is not counted twice. | Clarification. |

---

## 6. Source map

Authors: E = engine (code-written or recognised as engine), A = ai. Paths are under the Mission Control home. `m` = `missions/<id>/mission.json`, `ev` = `missions/<id>/events.jsonl`, `dp` = `missions/<id>/dispatch.json` (only `finalVerify.ok/reviewed/blocking` and `inflight`), `lock` = `mc.lock`, `quota` = `quota.json`, `usage` = `usage.jsonl`.

Every field also carries its source in the doc comment in `src/dashboard/types.ts`; where the two differ, `types.ts` wins and this table is fixed.

### 6.1 Top level, run, now

| Field | Source |
|---|---|
| `schemaVersion` | constant 1 |
| `generatedAt`, `generatedAtText` | builder's `now`; formatted in the time zone |
| `freshness.*` | constants (5.1) and fixed lamps (5.5) |
| `lamp.state/word/sentence/reasons` | derived: rule table 5.3, vocabulary 4.1, sentence rules 5.4 |
| `run.active`, `run.heartbeat` | derived: `lock` exists, parses as a lock, `statSync(lock).mtimeMs`, bands `LOCK_FRESH_MS` / `LOCK_STALE_MS` |
| `run.startedAt` | `lock` content key `at` (ISO), only for a lock that parses |
| `run.runningMs/Text`, `run.startedAtText` | derived: `generatedAt - startedAt`, only while active |
| `run.heartbeatAgeMs/Text` | derived: `generatedAt - mtime(lock)`, clamped at 0 |
| `run.stopRequested` | file `STOP` exists, probed directly (not `MissionStore.stopRequested()`) |
| `run.lastActivityAt/Text` | derived: max of the last event `at` and `m.updatedAt` of the worked mission, `mtime(dp)`, `mtime(logs/<openJobId>.ndjson)`; null unless a run is live and there is a worked mission. The **worked mission** is the mission that owns the open agent run (1.4); else the one with state `waiting`; else the one with state `working` whose last activity is newest; else none. A `staleBusy` leftover (4.2) is never the worked mission |
| `run.deadline` | derived: `parseUntil(--until, run.startedAt)` (`src/run.ts:60-74`); null without `--until`, without a live run, or when `startedAt` is null |
| `run.line`, `run.activityLine` | derived, vocabulary (E). `line`: live with a worked mission: `<title> (<kindWord>), running <runningText>` plus, with a deadline, `, stops <atText> (<leftText>)`; live without one: `A run is on, between missions, running <runningText>`; no live run and heartbeat `stale`: `The last run stopped answering at <the lock's mtime by the time rule of 4.6>.`; otherwise `No run is working right now.` `activityLine`: `Last activity <lastActivityText>`, or null |
| `now.kind/text` | derived: see below |
| `now.missionId`, `now.featureId` | the mission holding the open run; feature from the label (1.4), confirmed or filled by `dp.inflight.feature` |
| `now.since/sinceText` | the open `run.start` event's `at` |

`now` rules: not live → null. An open run exists (1.4) → kind `agent`, text from the label table below; this holds even when the mission's saved status is still `waiting`, because the agent after a wait runs under that status (1.8). Else a mission is `asleep` (state `waiting`) → kind `waiting`, text `WaitInfo.text`. Else the worked mission has state `working` → kind `between_steps`, `exact: false`: a feature in progress → `Running the checks on “F”`; else stage `gate_c` → `Running the final tests`; stage `finalize` → `Writing the report`; else `Getting the next step ready`. Else null.

Agent run text (capitalised, no final period, `F` = the feature's title in curly quotes, or "a feature" when none matches):

| Label | Role | Text |
|---|---|---|
| `onboard` | architect | An AI is reading the existing project |
| `spec` | architect | An AI is writing the plan |
| `gate-a` | reviewer | A second AI is checking the plan |
| `init` | engineer | An AI is setting up the app's foundation |
| `gate-c` | reviewer | A second AI is doing the final check of the whole app |
| `report-prose` | scout | A helper AI is writing the report |
| `test-<id>` | test author | An AI is writing the checks for `F` |
| `build-<id>` | engineer | An AI is building `F` |
| `review-<id>` | reviewer | A second AI is reviewing `F` |
| `fix-<id>` | engineer | An AI is fixing what the review found in `F` |
| `diagnose-<id>` | architect | An expert AI is working out why `F` keeps failing |
| `context-<id>` | scout | A helper AI is reading up on `F` |
| `digest-<id>` | scout | A helper AI is summarising why `F` failed |
| other | any | An AI is working |

### 6.2 Missions and features

| Field | Source |
|---|---|
| `missions[].id`, `.title`, `.kind` | `m` keys `id`, `title`, `kind` (cleaned). Unreadable: the folder name |
| `.readable` | `MissionStore.load` succeeded and the deep checks in 3.2 passed |
| `.scope`, `.openFromEarlier` | derived: scoping rule 12 |
| `.state/.word/.sentence/.pausedWhy` | `m.status`, `m.stage`, live run, the events (for `asleep` and `staleBusy`) and the last `mission.stopped` event; tables 4.2, 4.5, 4.6 |
| `.progress/.progressWord/.repairLap` | `m.stage`, `m.status`, `m.gateCRounds`; table 4.4 |
| `.featuresDone/.featuresTotal/.featuresLine` | count of `m.features[]` with `status === "done"`; `m.features.length` |
| `.waiting` | the newest `limit.wait` in `ev` (keys `until`, `reason`), only while the mission is `asleep` (4.2) |
| `.updatedAt` | `m.updatedAt`, else `m.createdAt` |
| `.tellLeader` | template 8 |
| `features[].id/.title` | `m.features[]` keys `id`, `title` (cleaned) |
| `.state/.word` | `m.features[].status` and the mission state; table 4.3 |
| `.reason` | `m.features[].blockedReason` through the reason table (9.2); the engine sentences of 4.3 for paused, on-hold and recovered |
| `.steps.used` | count of `attempts[]` with `action` `build` or `diagnose`, at most `total` |
| `.steps.total` | `settings.ladders[feature.kind === "mechanical" ? "mechanical" : "standard"]` (from `config.ladders`, `src/dispatcher.ts:1535-1537`) |
| `.steps.caption` | derived: `Tried <used> time(s) (<b> build try/tries and <d> expert diagnosis/diagnoses)` with `, <f> fix(es) after review` appended inside the brackets when `f > 0` and only the parts that are present; `No tries yet` when `used = 0` and `f = 0`. Example: `Tried 3 times (2 build tries and 1 expert diagnosis)` |
| `.reinforcements` | derived: `max(0, steps.used - 1)`. The first try is not a reinforcement; a clean first pass is 1 of 5 steps and 0 reinforcements |
| `.recovered` | derived: status `done` and an attempt with `action` `build`, `outcome` not `pass` |
| `.acceptanceTests` | `m.features[].frozenTests.length` |
| `.isRepair` | derived: `id` starts with `gate-c-fix-` (`src/dispatcher.ts:1935, 1941`) |
| `.cardId` | the card about this feature (9), else null |
| `.tellLeader` | template 8 |

### 6.3 Cards, allowance, timeline, debrief, counts

| Field | Source |
|---|---|
| `needsYou[]` | derived: 9 |
| `needsYou[].happened` | `blockedReason`, a `decisionsNeeded` entry, `failure.reason`, or an engine sentence; author per tables 9.2 and 9.3 |
| `needsYou[].ifNothing`, `.whatToDo`, `.title`, `.summary`, `.tellLeader`, `.fromEarlier` | vocabulary (E); table 9.1 (`whatToDo` is null where blank); `summary` is the feature's `steps.caption` plus a period; `fromEarlier` is the mission's scope |
| `allowance.providers[]` | `quota` keys `utilization[]`, `limits`, `modelBlocks`; `settings.providers`; rules 10 |
| `allowance.waiting` | the `WaitInfo` of the mission that is `asleep` (4.2) |
| `allowance.fileChangedAt/Text` | `statSync(quota).mtimeMs`; text "Usage figures last changed at 01:38" (time rule of 4.6: "... at Wed 01:38" on another day) |
| `timeline.items[]` | `ev` of recent missions through table 7, newest `TIMELINE_MAX_ITEMS` kept |
| `debrief.*` | derived: 11. Ticks from `m` (`features`, `decisionsNeeded`, `baselineBroken`, `gateCRounds`, `notes`) and `dp.finalVerify` |
| `debrief.missions[].agentTimeText/.agentRuns` | `usage` records with `missionId === id`: sum of `durationMs`, count |
| `counts.unreadableMissions` | folders under `missions/` whose `mission.json` failed to load or validate |
| `counts.openFromEarlier`, `.earlierNeedYou`, `.earlierWaitingForYou`, `.recentMissions`, `.olderMissionsHidden` | derived: scoping rule 12 |
| `counts.missionsNotShown`, `.cardsNotShown` | derived: missions and cards cut from `missions[]` and `needsYou[]` by the caps of 3.2 (0 on any normal home; the lamp and every other count still cover everything) |
| `counts.featuresDone/.featuresTotal/.featuresLine/.questions/.stuckFeatures` | derived over recent missions (`featuresLine`: "1 of 4 features done", or "No features planned yet") |
| `leader.*` | vocabulary constants (8) |

---

## 7. Timeline translation table

Source: each mission's `events.jsonl`, for the missions in `T` (recent), keeping events with `at >= generatedAt - RECENT_WINDOW_MS` (12). `T` = `titleOf(mission)`, `F` = the feature's title from `mission.json` by `data.feature` (a feature id that matches nothing becomes "a feature"). Quotes around names are “ ”. Time text is server-local. Every sentence below follows the glossary (4.0).

The event types below are the complete set the engine emits (the six `checkpoint.*` types of rows 27 to 32 were added with the checkpoints; the figure of 26 types elsewhere in this spec counts the table before them): `grep` of `this.event(` in `src/dispatcher.ts`, `appendEvent(` in `src/executor.ts` and `src/run.ts` (nothing else calls `appendEvent`; `src/git.ts`, `src/verify.ts`, `src/report.ts` and `src/notify.ts` have none), crossed with the types `describeEvent` names in `src/cli.ts:822-861`. That is **26 types**; the 14 marked ✓ occur in the authentic captures, the other 12 need synthetic fixtures (14.2).

Class: **M** = milestone (always kept), **D** = detail (kept only as the newest still-open step of its feature, see 7.2), **H** = hidden.

### 7.1 The table

| # | Type (emitted at) | Data keys used | Class | Tone | Sentence (note) |
|---|---|---|---|---|---|
| 1 ✓ | `mission.start` (`dispatcher.ts:454`) | `stage` | M | info | Started working on “T”. |
| 2 | `mission.resume` (`:454`) | `stage` | M | info | Picked “T” up again where it left off. |
| 3 | `mission.retry` (`:469`) | `failure` (not shown) | M | info | Trying “T” again. |
| 4 | `mission.stopped` (`:566`) | `reason` → stop table 4.5 | M | by reason | `deadline`: Paused: no AI would be free before the stop time. “T” continues on the next run. (warn) · `stop_requested`: Paused because a stop was requested or the stop time came. “T” continues on the next run. (warn) · `disk`: Paused: the disk is almost full. “T” continues once there is space. (bad) · `ai_failing`: Paused: the AI team kept failing. “T” continues on the next run. (bad) · `unknown`: Paused. “T” continues on the next run. (warn). Reason text never shown. |
| 5 ✓ | `mission.failed` (`:601`) | `reason` | M | bad | “T” needs your help. Note: the reason through the failure-reason table 9.3 (engine when matched, else ai). |
| 6 ✓ | `mission.end` (`:1966`) | `status` | M | good / warn / info | `done`: Finished “T”: done. (good) · `partial`: Finished “T”: partly done. (warn) · other: Finished “T”. (info) |
| 7 ✓ | `stage` (`:633`) | `from`, `to` | M or H | info / warn | `features`→`gate_c`: The building is finished. Starting the final check. (M, info) · `gate_c`→`features`: The final check found problems. Starting a repair round. (M, warn) · `features`→`finalize`: Skipped the rest of the building and moved on to the final steps. (M, warn) · every other pair (`onboard`→`spec`, `spec`→`gate_a`, `gate_a`→`init`/`features`, `init`→`features`, `gate_c`→`finalize`, `finalize`→`complete`): H |
| 8 ✓ | `feature.status` (`:649`) | `feature`, `to`, `reason` | by `to` | by `to` | `testing`: Started on “F”. (D, info) · `reviewing`: “F” is built. A second AI is reviewing it. (D, info) · `blocked`: “F” is stuck. (M, bad; note: `reason` through the feature reason table 9.2) · `skipped`: “F” was left out because it needed a stuck feature. (M, warn) · `building`, `done`, `pending`, other: H (the `merge` event reports done) |
| 9 ✓ | `attempt` (`:656`, `:1264`) | `feature`, `action`, `outcome`, `rung` | by case | by case | `feature` is `_init`: `pass`: The app's foundation is ready. (M, good) · other: The first try at the app's foundation did not pass. Trying again. (M, warn). `action` `build`, `outcome` not `pass`: “F” did not pass its checks (step `rung+1` of `N`). Calling in reinforcements. (M, warn; `rung` is the attempt's own recorded rung, so the step is the one that just failed. When `rung+1` is `N` or more, the sentence ends `All steps are used.` instead of `Calling in reinforcements.`, because the next event is "stuck". A feature the mission does not have, or a `rung` that is not a whole number of 0 or more, gives `“F” did not pass its checks. Calling in reinforcements.` with no step numbers. The next step is not guessed: the engine jumps to the diagnosis step after a repeated failure (`src/dispatcher.ts` `nextRung`) and a disputed test is diagnosed between two build steps. `N` is `steps.total` of that feature's view, because `buildTimeline` has no settings) · `build`, `pass`: H · `diagnose`, `pass`: An expert AI looked at why “F” keeps failing. (D, info) · `diagnose`, other: The expert diagnosis of “F” did not finish. (M, warn) · `fix`, `pass`: H · `fix`, other: A fix for the review's concerns on “F” did not pass and was undone. (M, warn). `summary` is never shown. |
| 10 ✓ | `verify` (`:790`) | `label`, `feature`, `ok`, `timedOut` | by case | by case | `label` is `gate-c`: `ok`: The final tests of the whole app passed. (M, good) · not `ok` and the mission's `baselineBroken` is false: The final tests of the whole app failed. (M, warn) · not `ok` and `baselineBroken` is true: The project's own full test suite failed. It was already failing before this work started. (M, info), because with a red baseline the engine passes the final check on the regression run (`src/dispatcher.ts:1873-1877`). `label` is `gate-c-features` (the red-baseline regression run, `:1904`): `ok`: The tests of the new features passed together on the final result. (M, good) · not `ok`: The tests of the new features did not all pass together on the final result. (M, warn). Other labels: `timedOut`: A check on “F” took too long and was stopped. (M, warn; without `feature`: A check took too long and was stopped.). Else H. (Red checks before a build are expected: H.) |
| 11 ✓ | `merge` (`:1860`) | `feature` | M | good | “F” is built and checked. |
| 12 ✓ | `run.start` (`executor.ts:322`) | — | H | — | Powers the now line (1.4). |
| 13 ✓ | `run.end` (`executor.ts:431`) | `outcome`, `label` | by outcome | by outcome | `timeout`, `crashed`: An AI step did not finish. It ran too long or stopped working. (M, warn; with a matching feature: An AI step on “F” did not finish. It ran too long or stopped working.) · `auth`: A login has expired. (M, bad) · `ok`, `failed`, `limited`, `aborted`, other: H |
| 14 ✓ | `limit.wait` (`:430`) | `until`, `reason` | M | warn | `WaitInfo.text` (4.6): e.g. Waiting for allowance until 12:59. It resumes by itself. |
| 15 ✓ | `report` (`:2072`) | `path` (never shown) | H | — | (`mission.end` follows it.) |
| 16 | `error` (`:557`, `:1333`; `run.ts:452`) | `feature` | M | bad | Something went wrong inside Mission Control. The work so far is kept. (with a matching feature: Something went wrong inside Mission Control while working on “F”. The work so far is kept.) `message` never shown. |
| 17 ✓ | `spec` (`:1165`) | `features` (array of ids) | M | info | The plan is ready: `n` features. (`n = 1`: The plan is ready: 1 feature.) If an earlier `spec` event of the same mission is in the window: The plan was revised: `n` features. |
| 18 ✓ | `tests.frozen` (`:1418`) | `feature`, `files` | D | info | Wrote `k` checks that “F” must pass. The AI that builds it cannot change them. (`k = files.length`; `k = 1`: Wrote 1 check that “F” must pass. The AI that builds it cannot change it.) |
| 19 | `tests.stray` (`:1513`, `:1524`) | `feature` | M | warn | While writing the checks for “F”, an AI changed files it should not. The changes were undone. |
| 20 | `frozen.reverted` (`:1609`) | `feature` | M | warn | While building “F”, an AI changed the checks it must pass. The change was undone. |
| 21 | `feature.added` (`:1949`) | `feature` | M | warn | The final check found problems, so a repair feature was added. |
| 22 | `run.interrupted` (`:482`) | `label` | M | warn | Work was cut off by a restart or a failure. That step is tried again. |
| 23 | `processes.reaped` (`:812`) | — | H | — | |
| 24 | `branch.restored` (`:868`) | — | H | — | |
| 25 | `git.locks.removed` (`:952`) | — | H | — | |
| 26 | `git.settings.restored` (`:981`) | — | M | warn | An AI changed the app's version-control settings. The change was undone. |
| 27 | `checkpoint.parked` (`src/dispatcher.ts`) | `kind`, `feature` | M | warn | `plan`: Waiting for your check of the plan for “T”. · `feature`: Waiting for your check of “F” before it is added. · `final`: Waiting for your check of the finished app. |
| 28 | `checkpoint.answered` (`src/checkpoint.ts`) | `kind`, `feature`, `decision` | M | good (`approve`) / info (`send_back`) | `approve`: You approved the plan. “T” carries on when the next run starts. (`feature`: You approved “F”. …; `final`: You approved the finished app. …) · `send_back`: You sent the plan back. It is revised and shown to you again. (`feature`: You sent “F” back. It is changed and shown to you again.; `final`: You sent the finished app back. Your change is added and shown to you again.) |
| 29 | `checkpoint.reworked` | `kind`, `feature`, `ok` | M | info / warn | `plan`: The plan was revised after your note. · `feature`: “F” was changed after your note. · `final`: A new feature was added for your change. · `ok` is `false`: Your change could not be made. The earlier version is shown again. (warn) |
| 30 | `checkpoint.passed` | — | H | — | The `mission.resume` that follows reads as the continuation. |
| 31 | `checkpoint.limit` | `feature` | M | bad | You sent this back twice before, so “T” stops here. The report says what to do. (For a feature check: You sent “F” back twice before, so it is set aside. The rest carries on. The report says what to do.) |
| 32 | `checkpoint.rejected` | `reason` | M | warn (`no_record`: bad) | An answer to the check of “T” was ignored because it did not match. The check is still waiting. |
| — | any other `type` | — | H | — | Unknown events are hidden, never shown raw (`describeEvent`'s fallback prints their data; the dashboard does not). |

Item fields: `at` = event `at`; `time` and `day` formatted; `missionId` = event `missionId`; `featureId` = `data.feature` when the sentence names it, else null; `text` = the sentence (engine-written); `note` = the optional extra (Said); `author` = `"ai"` when `note.author` is `"ai"`, else `"engine"`; `count` = 1 until merged.

### 7.2 Keeping the timeline short

Applied in this order:

1. Drop class H and events before `generatedAt - RECENT_WINDOW_MS`.
2. Per mission and feature `F`: let `lastM` be the position of the last M item whose `featureId` is `F`. Drop every D item about `F` before `lastM`. Of the D items about `F` that remain, keep only the newest. (A feature that finished shows one line, “F” is built and checked; a stuck one shows its reinforcements and "is stuck"; the feature in progress shows its one latest step.)
3. Merge consecutive items of the same mission with identical `text`, `tone` and `note` (so no AI note is dropped) into one with `count` = how many (keep the first `at`). The page reads a merged item as "3 times" (17.1).
4. Order by `at` (ties: the order in the file), oldest first.
5. If more than `TIMELINE_MAX_ITEMS` remain, drop from the front and set `earlierNotShown` to how many.

Measured with a prototype of the earlier wording of this table and these rules over the authentic captures (`timeline-proto2.mjs`; the rewording above changes sentences, not which events are kept): the happy 4-feature run is 101 events and 10 lines (start, plan, foundation, four built, final check start, final tests, finished); the partial run 89 events and 12 lines (the two reinforcements, "stuck" and "left out" included); a mid-run capture 36 to 49 events and 5 lines (its newest step is the last line); the limit-then-done run 66 events and 9 lines; the failed run 29 events and 6 lines. Without rule 2 the happy run was 27 lines. An independent re-implementation written from this table alone gave 10, 12, 5, 5, 5, 9 and 6 lines for the same captures. The unit tests pin the exact lists on the fixtures.

---

## 8. Tell the leader

The page never sends anything. Every Needs-you card, every feature tile that is not a first-try Done tile (17.1), and one global bar have a button that opens a sheet. The card and tile buttons read "Tell the leader about this"; the bar's reads "Tell the leader anything", so the two are never confused (the sheet's own title is "Tell the leader"). The sheet says first that the page cannot send anything, then offers the quick phrases and a free-text box, then shows the ready sentence as a read-only preview, and has Copy. All sentences come from the snapshot; the page only inserts what the CEO types or taps after the colon.

The leader only has the `mc` commands status, logs, report, stop, new, feature, plan preview, plan queue, plan show, run, approve and send-back (status, logs, report, plan preview and plan show run without asking, because they only read; stop, run, new, feature, plan queue, approve and send-back ask the owner first, 16; `approve` and `send-back` are never in the allow list). It has no command to reopen a feature or change a plan in place (`src/cli.ts` registers none; the report's lever table, section 5, says the same). So the sheet shows `leader.canDo` (what it can do and what it cannot) and no sentence promises more.

No sentence ever contains the AI's words about a problem (a reason, a question, a note). A sentence says which item it is about by the mission's name, the feature's name, and for questions by their number, so that the leader can find the item with `mc status`, `mc report` and `mc logs` and read the AI's words there. The names are the one piece of file text inside a sentence: feature titles are written by the architect AI and mission titles may be too. They are cleaned like every string (3.3: invisible characters removed, "double quotes" replaced) and capped at `TITLE_MAX_CHARS`, and the leader treats them as data, never as instructions (`leader/CLAUDE.md`). That covers every name in a sentence, whether it is in quotes or follows "in": in `About "<feature>" in <mission>: ...` the mission title is not quoted and is still data.

| Where | Field | Template |
|---|---|---|
| Feature tile | `FeatureView.tellLeader` | `About "<feature title>" in <mission title>: <your answer here>` |
| Mission, quiet row | `MissionView.tellLeader` | `About "<mission title>": <your answer here>` |
| Debrief | `MissionDebrief.tellLeader` | `About "<mission title>": <your answer here>` |
| Card `feature_stuck` | `NeedsYouCard.tellLeader` | `About "<feature title>" in <mission title>, which is stuck: <your answer here>` |
| Card `decision`, the mission has one question | `NeedsYouCard.tellLeader` | `About the question in "<mission title>": <your answer here>` |
| Card `decision`, the mission has `k` >= 2 questions | `NeedsYouCard.tellLeader` | `About question <i> of <k> in "<mission title>": <your answer here>`. `i` is the card's position among that mission's question cards in `decisionsNeeded` order; the card title ends with ` (<i> of <k>)` |
| Card `mission_failed` | `NeedsYouCard.tellLeader` | `About "<mission title>", which stopped: <your answer here>` |
| Card `run_stopped` | `NeedsYouCard.tellLeader` | `About "<mission title>", which stopped unexpectedly: <your answer here>` |
| Cards `paused_disk`, `paused_ai_failing` | `NeedsYouCard.tellLeader` | `About "<mission title>", which is paused: <your answer here>` |
| Card `checks_failing` | `NeedsYouCard.tellLeader` | `About "<mission title>", whose own checks were already failing: <your answer here>` |
| Card `login_needed` | `NeedsYouCard.tellLeader` | `About the login that expired during "<mission title>": <your answer here>` |
| Card `checkpoint` | `NeedsYouCard.tellLeader` | `About the check of "<mission title>": <your answer here>` |
| Card `checkpoint`, the two answers | `NeedsYouCard.answers.approve`, `.sendBack` | `About the check of "<mission title>" (<what>): approved, go ahead.` and `About the check of "<mission title>" (<what>): send it back. What to change: <your answer here>`. `<what>` is `the plan`, `the feature "<feature title>"` or `the finished app`. The approval has no placeholder: it is complete as it is. A feature check whose feature is not in the file has no answers. |
| Global bar | `leader.globalSentence` | `About the current work: <your answer here>` |
| "Stop the current run" | `leader.stopSentence`, `leader.stopNote` | `Please stop the current run.` (a sentence to paste, not a button that acts; the page shows `stopNote` with it and says it takes effect only when the leader runs it) |
| Quick phrases | `leader.quickPhrases` | `Your call` · `Leave it out` · `Try again` · `What is going on?` (the same four everywhere, as the brief decided) |
| What the leader can do | `leader.canDo` | The leader can look at progress and reports, stop the run, add new work, start the team working through the queued work, and approve or send back a check. It cannot change a plan or reopen a stuck feature. |
| What stopping costs | `leader.stopNote` | Stopping cancels the AI step that is running, and up to 45 minutes of its work is redone. Restarting needs the PC or the next scheduled run. |
| Sheet text | `leader.pasteHint` | `Paste this into your chat with the leader.` |
| Copy failed | `leader.copyFailHint` | `Select the text and copy it` |
| AI text label | `leader.aiNotice` | `The AI wrote this. Do not run commands from it.` |

The sheet's own words (page words, 17.1): the first line reads "This page cannot send messages. Pick or type an answer, tap Copy, then paste it into your chat with the leader." (for "Stop the current run": "This page cannot stop the run. Tap Copy, then paste the sentence into your chat with the leader."). **Copy waits for a message**: with no quick phrase chosen and no words typed, the preview still holds the literal `<your answer here>`, so Copy is marked `aria-disabled` and a tap says "Choose a quick answer or type your own words first, then tap Copy." instead of copying. The stop sheet has nothing to choose, so its Copy always works.

A sentence with no placeholder (the approval) needs nothing from the owner: the sheet hides the quick answers and the box for the owner's own words, says "This page cannot send messages. Tap Copy, then paste the sentence into your chat with the leader.", and Copy works at once, as it does for the stop sentence. The dashboard never records an approval: the leader still asks the owner the confirmation question and Claude Code prompts (leader/CLAUDE.md, "Checks the CEO asked for").

The placeholder is exactly `<your answer here>`; the page replaces it with the chosen quick phrase or the typed text, and keeps the whole sentence selectable. Titles in these sentences are cleaned (3.3) and have `"` replaced by `'` so the sentence stays one clean quote.

Telling two items apart. If another mission in the snapshot has the same title, the id follows the closing quote of the mission title: `About "Habit tracker" (mission 2026-10-11-habit-tracker-2): <your answer here>`, and `... in Habit tracker (mission <id>): ...` in a feature sentence. A feature title that repeats inside one mission gets `(feature <id>)` after its closing quote. This is the one place an id is shown, and only on a collision. A start time would read better but the leader cannot use it: `mc status` and `mc status --json` list ids and titles and no start time (`capture/cli/ALL.status-final.json.txt`), so the id is the only handle it can match.

---

## 9. Needs-you cards

Cards exist for **recent missions** (12), plus one amber `mission_failed` card for each earlier failed mission (`fromEarlier: true`), because the lamp is amber for it (L15) and the Needs-you tab must say why. Every other earlier item is shown in the quiet row only and cannot be told to the leader from a card; the global bar covers it.

### 9.1 Kinds

| Kind | Severity | One per | Title (engine) | `happened` | `summary` | `ifNothing` |
|---|---|---|---|---|---|---|
| `mission_failed` | now (recent), look (earlier) | mission with status `failed` | `“<mission>” needs your help` (earlier: `“<mission>” still needs your help`) | the failure reason through 9.3 | null | `failure.retryable`: It stays stopped until someone logs in again on the PC. After that the next run carries on by itself. · else: Nothing happens. It stays stopped until someone restarts it. |
| `checkpoint` | look | recent mission whose `checkpoint.state` is `pending` (an `answered` one has no card) | `“<mission>”: please check the plan` · `“<mission>”: please check “<feature>” before it is added` · `“<mission>”: please check the finished app` | engine: The team stopped here because you asked to look at it first. For the plan stop of a mission whose plan was queued with `mc plan queue` (the cleaned mission has a `plan`): `The team stopped here because the leader wrote this plan, and you look at it first.` (such a plan stops by default, so "because you asked" would not be true). The look's lines are in `lines` (below) | engine: `Nothing is built yet. The report has the whole plan.` (plan; for a leader plan: `Nothing is built yet. Ask the leader to show you every check of the plan, word for word. The owner can also print all of it at the PC.`, because the card holds at most 12 lines and a plan is longer) or `The work is saved under the name <name>. The report says how to open it.` (feature, final; without a name: `The report says how to open it.`); from the second send-back of the same scope, the summary adds ` You have sent this back <n> times. If you send it back again, the work stops here: <end state>. You can still approve.` | Nothing happens. This mission waits for you. Other work carries on. |
| `run_stopped` | now | recent mission saved busy with no live run, once L2 fires (during the grace L3 shows amber and there is no card yet) | `“<mission>” stopped unexpectedly` | engine: The run stopped without finishing. The work so far is kept. | null | The next run carries on from the last saved step. |
| `paused_disk` | look | recent mission paused with `disk` | `“<mission>” is paused` | engine: The disk is almost full, so work paused. | null | Work stays paused until there is free space. The next run carries on where it stopped. |
| `paused_ai_failing` | look | recent mission paused with `ai_failing` | `“<mission>” is paused` | engine: The AI team kept failing, so work paused. This is not a problem with the work. | null | The next run carries on where it stopped. |
| `feature_stuck` | look | feature of a recent mission with state `stuck` | `“<feature>” is stuck` | the reason through 9.2 (no reason: engine "It could not be finished.") | engine: the feature's `steps.caption` plus a period, e.g. Tried 3 times (2 build tries and 1 expert diagnosis). | mission state `working`, `waiting`, `paused` or `not_started`: The rest carries on. This feature stays out, and the mission ends Partly done. · mission `needs_you`: The mission has stopped, so nothing carries on until it is restarted. · mission `done` or `partly_done`: It stays out. Nothing tries it again unless you ask. · mission `unknown`: Mission Control cannot tell what happens next. In each case, when features were left out because of it: add ` “X” needed it, so that stays out too.` (one title) / ` “X” and “Y” needed it, so those stay out too.` (two) / ` <n> features needed it, so those stay out too.` (more) |
| `decision` | look | each `decisionsNeeded` entry not consumed (9.4) | the headline of 9.3 (`Have someone check the app` / `A question for you`), with ` (<i> of <k>)` appended when the mission has `k` >= 2 question cards | the entry through 9.3 | null | concerns: Nothing changes. The mission stays Partly done. · other: Nothing happens. The question stays open. |
| `checks_failing` | look | recent mission with `baselineBroken` | `“<mission>”: the project's own checks were already failing` | engine, one of three by the mission (10.3 of the modes spec): no feature has a mode: The project's own checks were already failing before this mission started, so the new work was checked by its own new tests only. · a feature has a mode and no finished feature is checked by tests: The project's own checks were already failing before this mission started, so they could not be used to judge the new work. · a feature has a mode and a finished feature is checked by tests: the sentence just above, then ` The features checked by tests were judged by tests alone, and the others by Mission Control's own checks and a second AI.` | null | Nothing changes. Someone may want to look at the older failures. |
| `login_needed` | look | recent mission that is asleep with cause `login` (4.6) | `One AI needs a new login` | engine: `<Names> needs a new login on the PC.` (`<Names>` as in 4.6; no recognised name: `One AI needs a new login on the PC.`) then ` The run is waiting until <when> and then carries on with the other AI.` (the time by the rule of 4.6; "waiting", not "asleep", 4.0) | null | The login stays expired until someone logs in again. The run carries on with the other AI when it can. If both need a login, the mission stops and needs your help. |

`whatToDo` (author always `engine`; null where the table has no row):

| Kind | `whatToDo` |
|---|---|
| `mission_failed`, the reason is `No model could run: <providers> need(s) a new login.` | `Log in again to <Names> on the PC, then tell the leader.` (`<Names>` = "Claude", "Codex" or "Claude and Codex" for the providers the reason names; none the engine knows: `Log in again on the PC to the AI that needs it, then tell the leader.`) |
| `mission_failed`, any other reason, readable or not | `Ask the leader what went wrong. If it can be fixed, start the team working again with the leader.` |
| `run_stopped` | `Tell the leader to start the team working again.` |
| `paused_disk` | `Free some space on the PC, then tell the leader to carry on.` |
| `checkpoint` | `Look at it as the report describes, then tell the leader to approve it or send it back.` |
| `login_needed` | `Log in again to <Names> on the PC, then tell the leader.` (`<Names>` as in 4.6; none: `Log in again on the PC to the AI that needs it, then tell the leader.`) |
| `feature_stuck`, `decision`, `checks_failing`, `paused_ai_failing` | null (the step is the owner's own call, or nothing is needed) |

A `checkpoint` card is amber (`look`), never red. It is the one kind with two more fields: `lines` (the engine's look at the work, at most 12 lines, every one of them `author: "ai"`, because the engine writes some and AIs write others and the page does not parse them; the key is absent when there are none) and `answers` (the two sentences of section 8; absent when there are none to give). No other kind has either key, and a test says so. The card's feature id is the checked feature's. The end states in the summary are the engine's own words (`endState` in `src/checkpoint.ts`): `nothing will be built` (plan), `this feature is set aside and the rest carries on` (feature), `the finished result is kept as it is` (final). The cap of two send-backs is `CHECKPOINT_SEND_BACK_CAP` in `constants.ts` (the engine does not export its own).

A `whatToDo` holds no mission or feature name and no quote, ends with a period, and has at most one sentence break, so its first sentence stands alone (the page shows it as the second line of the strip row). No raw command appears in it.

`tellLeader` is the sentence of the card's kind in section 8. A `decision` card is one question card; the discriminator `i of k` is in its sentence and title.

Order: severity `now` first, then missions in `missions[]` order, then the order of `CARD_KINDS` (`mission_failed`, `checkpoint`, `feature_stuck`, ...), then feature order. `id` = `<kind>:<missionId>:<featureId or the entry's index>`. A feature's `cardId` points at its `feature_stuck` card.

### 9.2 Feature reasons (`blockedReason`) → text and author

Matched against the cleaned reason, first match wins. A match is `engine`; no match is `ai` (the architect's own block reason, `src/dispatcher.ts:1740-1742`, and anything unknown). The right column is the text shown.

| Source string (engine) | Pattern | Shown |
|---|---|---|
| `tried every escalation step, but its checks still failed` (`:1546`) | exact | The AI team tried every step it has, and the checks still failed. |
| the "uncheckable" sentence (`:125-126`, used at `:1547`) | exact `no acceptance tests could be written for it, and the project's own checks were already failing, so nothing could check it` | It could not be checked: no tests could be written, and the project's own checks were already failing. |
| `its changes conflicted with work merged earlier (merge conflict)` (`:1854`) | exact | Its changes clashed with work that was already put together. |
| `merging it failed: <error>` (`:1854`) | `^merging it failed: ` | Putting it together with the rest failed. (the error is dropped) |
| `its checked work did not end up in the mission branch when it was merged` (`:1857`) | exact | Its checked work did not make it into the app. |
| `internal error: <message>` (`:1334`) | `^internal error: ` | Something went wrong inside Mission Control while working on it. (the message is dropped) |
| `Mission Control stopped unexpectedly <n> times while working on it (...)` (`:485, :489`) | `^Mission Control stopped unexpectedly \d+ times while working on it` | Mission Control kept stopping while it worked on this (for example a restart or a failure). |
| `the mission reached its safety cap of <n> agent runs before this feature was finished` (`:518`) | `^the mission reached its safety cap of \d+ agent runs` | The mission used up its safety limit of AI runs before this was finished. |
| `it needs a decision from you` (`:1740`, the fallback when the architect gave no reason) | exact | The AI team needs a decision from you. |
| `you asked for changes twice and it still was not right` (`limitReached`, checkpoints: a feature sent back once too often) | exact | You asked for changes twice and it still was not right, so it was set aside. |
| skipped: `waiting on “<title>”, which was blocked|skipped` (`:1312`; Step 3 changed the marks around the title from straight to curly, and missions from before still hold the straight ones) | `^waiting on ["“](.+)["”], which was (blocked|skipped)$` | It needed “`<title>`”, which is stuck. (`skipped`: ..., which was left out.) |
| anything else | — | the cleaned text, **author ai** |

### 9.3 Decisions and failure reasons → text and author

`decisionsNeeded` entries (`src/types.ts:405`):

| Entry | How it is recognised | Shown | Author |
|---|---|---|---|
| the mission's failure decision (`src/dispatcher.ts:549-552, 1011`, ...; has terminal commands) | equals `mission.failure.decision` | not shown as a decision; the failure reason is shown instead (below) | — |
| `Have someone check the app before you rely on it: <concerns>. “Review notes” and “Technical details” list what the reviewers found.` (`src/dispatcher.ts:2007`) | the **whole** entry matches `CONCERNS_ENTRY` (below). An entry that only starts with the same words, or has any part that is not one of the three shapes, does not match | Have someone check the app before you rely on it: `<concerns>`. (the concerns are engine-built; they may name feature titles) | engine |
| `"<feature title>": <reason>` (`:1741`, the architect's block) | `^"(.+?)": (.*)$` where the title is a feature of the mission with status `blocked` | consumed by that feature's card (9.4) | ai |
| anything else, including a forged "Have someone check the app ..." that fails the whole-entry match | — | the cleaned entry (it may be an AI-written question or a command; never run) | **ai** |

`CONCERNS_ENTRY` is built from the three concern shapes `openReviewConcerns` produces (`src/dispatcher.ts:2023-2030`), joined by `"; "` (the engine's own join, `:2007`):

```
PART1 = the final review of the whole app did not finish, so nobody reviewed it as a whole
PART2 = the final review found \d+ serious problems? that (?:was|were) not fixed
PART3 = the reviewers' \d+ serious findings? on [^;]+? (?:was|were) not fixed
CONCERNS_ENTRY = ^Have someone check the app before you rely on it: (?:PART1|PART2|PART3)(?:; (?:PART1|PART2|PART3))*\. “Review notes” and “Technical details” list what the reviewers found\.$
```

A feature title that contains a semicolon makes PART3 fail to match; the entry is then labelled as AI-written, which is the safe direction. A test (T-CARD) feeds an AI-style entry that begins with "Have someone check the app before you rely on it:" and ends differently, and expects author `ai`.

Failure reasons (`mission.failure.reason`, else the last `mission.failed` event's `data.reason`):

| Source string | Pattern | Shown | Author |
|---|---|---|---|
| `No model could run: <providers> need(s) a new login.` (`:552`) | `^No model could run: .+ needs? a new login\.$` | A login has expired. `<Names>` has to be logged in again on the PC. (`<Names>` = "Claude", "Codex", or "Claude and Codex" with "have"; when the reason names no provider the engine knows: A login has expired. Claude or Codex has to be logged in again on the PC.) Provider ids are looked up with `Object.hasOwn` (3.2). | engine |
| `Unknown profile "<p>".` (`:439`) | `^Unknown profile ` | The mission asks for an AI setup that does not exist. | engine |
| `The folder <x> is not a git repository.` (`:1009`) | `is not a git repository\.$` | The app's folder is not set up for version history. | engine |
| `The repository <x> is a shallow clone.` (`:1015`) | `is a shallow clone\.$` | The app's folder only has part of its version history. | engine |
| `Could not work out how to check this project: ...` (`:1058`) | `^Could not work out how to check this project` | The AI could not work out how to run this project's checks. | engine |
| `The plan could not be made...` (`:1120`, `:1122`) | `^The plan could not be made` | The AI could not make a workable plan from the request. | engine |
| `The app scaffold never passed its checks (<n> attempts).` (`:1212`) | `^The app scaffold never passed its checks` | The app's foundation never passed its checks. | engine |
| `The project's own checks already fail, and there is no command that runs single test files.` (`:1107`) | exact prefix `The project's own checks already fail` | The project's own checks already fail, and they could not be used to check new work. | engine |
| `Mission Control stopped unexpectedly <n> times ..., at the step "<label>".` (`:493`) | `^Mission Control stopped unexpectedly \d+ times` | Mission Control kept stopping at one step (for example a restart or a failure). | engine |
| `Internal error in stage <s>: <message>` (`:558`) | `^Internal error in stage ` | Something went wrong inside Mission Control. The work so far is kept. | engine |
| `You asked for changes to the plan twice and sent it back a third time, so Mission Control stopped before building anything.` (`limitReached`, checkpoints) | `^You asked for changes to the plan twice and sent it back a third time` | the same sentence | engine |
| anything else | — | the cleaned reason | **ai** |

### 9.4 One fact, one card

A blocked feature's architect decision `"<title>": <reason>` and the feature's own `blockedReason` are the same sentence. The feature card consumes the matching `decisionsNeeded` entry (title equals the feature's title and the rest equals `blockedReason`, or the title matches a blocked feature). The `failure.decision` is consumed by the failed-mission card. What remains becomes `decision` cards. Verified on the fixtures: `partial-blocked/` has the one decision `"Sign-up page": <signup.blockedReason>` and `failed-auth/` has the one decision equal to `failure.decision`, so neither has a question card.

**Open items.** For one mission, `openItems` is the number of its cards of kinds `decision`, `feature_stuck` and `mission_failed`. The debrief's Nothing-open tick and its verdict use this one number (11), so the same fact is never counted by a different rule. The lamp uses the card counts directly: `counts.questions` (the `decision` cards, L10) and `counts.stuckFeatures` (L9). Consequently the partial fixture reads "1 feature is stuck." in the lamp and "1 item is waiting for you." on the tick, and never "1 question".

---

## 10. Allowance rules

Inputs: `quota.json` (1.3), `settings.pacing`, `settings.providers`, the asleep mission's `WaitInfo`, `generatedAt`.

1. **Rows.** One row for every provider in `settings.providers` (Claude and Codex under the default config), then any other provider that appears in `quota.json`. Labels: `claude` → "Claude", `codex` → "Codex", `mock` → "Test AI", other → the id cleaned.
2. **Valid data only.** A reading counts when `provider` matches, `utilization` is a finite number `>= 0`, `window` is a string, and `resetsAt` is a finite number **after** `generatedAt`. A window that already reset has no valid reading. A limit counts when `limits[provider].until > generatedAt`. A `quota.json` that is unreadable, over `MAX_QUOTA_BYTES`, or not an object is treated as absent. Invalid entries are skipped one by one.
3. **Windows.** One entry per valid reading: `usedFraction` = `utilization`; `usedPercent` = rounded percent (may be above 100); `fill` = clamped 0..1; `overage` = above 1; `resetsAt`. Order: `five_hour`, `seven_day`, then the rest by name. If the same window appears twice, the later entry wins.
4. **Labels** (no model names): `five_hour` → "Next 5 hours"; `seven_day` → "This week"; `seven_day_<anything>` → "This week, one kind of model"; `<n>_minutes` with `n` a multiple of 60 → "Next `n/60` hours", other `n` → "Next `n` minutes"; anything else → "Another limit".
5. **`pauseAt`**: `five_hour` → `settings.pacing.maxFiveHourUtilization` (default 0.97); `seven_day` → `maxWeeklyUtilization` (0.85); others null. The page draws a tick there, labelled "work pauses here".
6. **Reset text**: same local day as `generatedAt` → `resets 03:20`; another day → `resets Thu 09:00`; 6 days or more away → `resets Mon 19 Oct 10:03`. `text` = `62% used, resets 03:20`. The model-block sentence of 10.9 and `fileChangedText` of 10.11 follow the same rule (4.6).
7. **Blocks, `limitedUntil`, `limitedText`.** The engine blocks a provider in two ways that show in `quota.json`, and the pill must show both as "waiting":
   - a **limit entry**: `limits[provider]` with `until > generatedAt` (kind `session`, `weekly`, `model`, `spend`, `throttle` or `unknown`);
   - a **pacing block**: a valid reading of a paced window (`five_hour`, `seven_day`) with `usedFraction >= pauseAt`. The engine refuses new work on that provider until the window's `resetsAt` (`src/quota.ts:358-369`, kind `session` for `five_hour`, `weekly` for `seven_day`) but writes **no** `limits` entry for it (verified by driving the real governor at weekly 0.9: the file's `limits` stays `{}` while `state(claude)` is limited, `contract-review-feas/quota-real-output.txt` item 5).

   `limitedUntil` = the latest end among these blocks (on a tie the limit entry's kind), else null; the kind of that block picks the wording. `limitedText` = `Waiting for <what> to reset. Work resumes <when>.` with `<what>`: `session` → "the 5-hour limit", `weekly` → "the weekly limit", `model` → "a model limit", `spend` → "the spending cap", `unknown` → "a usage limit"; `throttle` → `Waiting because the service is busy. Work resumes <when>.` `<when>` is the block's end **plus `WAIT_MARGIN_MS`**, as `at 12:59` on the same local day, `Thu 09:00` on another, and `Mon 19 Oct 10:03` from 6 days away. It is the same minute the wait banner shows (`limit.wait.until` is the reset plus the same margin, `src/executor.ts:253`), so the screen never shows one instant as two different minutes. The window rows keep showing the plain reset ("resets 12:58"), which is a different fact. The `raw` text is never used. The share of the week one run may use (a setting under `pacing`) also blocks, but it is kept in memory only (`src/quota.ts:130`), so it cannot be shown and the debrief note says so.
8. **Pill** (first match wins):

| State | Word | When |
|---|---|---|
| `waiting_reset` | Waiting for reset | `limitedUntil` is set |
| `no_reading` | No reading yet | no valid window |
| `nearly_out` | Nearly out | some window has `usedFraction >= PILL_NEARLY_OUT` (0.90) (a paced window at or above its pause cap is already `waiting_reset`) |
| `getting_low` | Getting low | the highest `usedFraction` is `>= PILL_GETTING_LOW` (0.70) |
| `plenty` | Plenty | otherwise |

9. **Notes**: no valid window → "No usage reading yet." (neutral, never a fault); a valid reading but no `five_hour` window → "No 5-hour limit reported." (with the final period, so the model-block sentence can follow; a plan may have none, report section 4); a model-specific block still ahead (`modelBlocks`, `until > generatedAt`) → append "One kind of model is limited until HH:MM." (on the day of the snapshot) or "One kind of model is limited until Wed 15:26." (another day) or "... until Mon 19 Oct 10:03." (6 days or more away) without naming it. The note is the first sentence that applies; the model-block sentence is appended to it with a space.
10. **Banner** (`allowance.waiting`): the `WaitInfo` of the mission that is `asleep` (4.2; the first, if several), else null. A `waiting` mission whose agent is already running after the wait gives no banner.
11. **File time**: `fileChangedAt` = mtime of `quota.json`, `fileChangedText` = "Usage figures last changed at 01:38" (same local day as `generatedAt`) or "Usage figures last changed at Wed 01:38" (another day; `quota.json` can be days old) or "Usage figures last changed at Mon 5 Oct 01:38" (6 days or more ago: the date, because a weekday repeats every week). The engine rewrites the file only when a reading changed (`src/quota.ts:187`), so "last changed" is exactly what the time means, and a reading that has stayed the same since is correctly older than now. Never "as of".
12. The snapshot has no "this run so far" share and no per-run limit figure: the engine keeps them in memory only (1.3). The debrief shows the current allowance pills under "Allowance now" and the `allowanceNote` (17.1), which covers the brief's "allowance used" item as far as the data allows.

The path from a real Claude or Codex reading to this row is **unproven**: no capture contains a utilization reading. Tests drive it with a synthetic `quota.json` of the exact shape the runners' parsers produce (14.2).

---

## 11. Results (the debrief)

A mission that waits for a check (`checkpoint.state` `pending`) is not in the results: it has its card, and "Paused. It continues on the next run." would not be true of it yet. Once the answer is recorded it is a paused mission like any other.

`debrief` is null unless at least one mission in `T` has state `done`, `partly_done`, `needs_you`, or `paused` with `pausedWhy` other than `unexpected` (a dead run has a red card, not a debrief). One `MissionDebrief` per such mission, in `missions[]` order.

**Verdicts** (per mission), with `d`, `n` = features done and total, `s` = stuck features, `l` = left-out features, `q` = the mission's question cards:

- `done` → "Done", "All `n` features are built and checked." (`n = 1`: "The feature is built and checked.").
- `partly_done` → "Partly done". When `d === n` (every feature is built; the final check left something open, for example a repair round that did not fix everything or open review concerns): "Every feature is built, but the final check left something open." Otherwise "`d` of `n` features are built and checked." Then, in this order and only those present: " 1 feature is stuck." / " `s` features are stuck."; " 1 feature was left out." / " `l` features were left out." (only when `s = 0`); " 1 question is waiting for you." / " `q` questions are waiting for you."
- `needs_you` → "Needs you", "It needs your help."
- `paused` → "Paused", "Paused. It continues on the next run."

The overall verdict is the worst by the order needs_you, partly_done, paused, done; its sentence is the mission's when there is one mission, else "`k` missions: 1 done, 1 partly done." (words in that order, counts of those present).

**What you got**: features with status `done`. `note` = the feature's `story` (AI-written one-liner, cleaned to `REASON_MAX_CHARS`, author ai), null when absent. **Not finished** (the field is `leftOut`; the page's heading is "Not finished", because a stuck feature is not "left out" in the CEO's words): features `blocked` or `skipped`, `note` = the reason through 9.2. **Recovered**: features with `recovered`. `attempts` = steps used. `plannedLine` = "`n` feature(s) planned" (a one-feature plan ticks easily; the page shows the number beside the ticks).

**The four ticks** (always four, in order). `d`, `t` = done and total features; `dp` = the three `dispatch.json` values; `openItems` is defined in 9.4.

| Tick | `yes` when | `no` when | `unknown` when |
|---|---|---|---|
| **Delivered** | `t > 0` and `d === t` | else | never |
| **Final review passed** | the mission's `stage` is `complete`, at least one feature is done, `dp.finalVerify` exists, `reviewed !== false`, `ok === true`, `(blocking ?? 0) === 0` | `reviewed === false`; or `ok === false`; or `blocking > 0`; or no feature was done (the final check is skipped, `src/dispatcher.ts:1870`); or the stage is not `complete` (the check has not run); or `dispatch.json` is readable but has no `finalVerify` (the engine sets it only when the final check completes, `src/dispatcher.ts:1883-1884`, so a run cap or stop before it leaves none) | `stage` is `complete`, a feature is done, and `dispatch.json` is missing, unparseable or over the cap |
| **Nothing open** | `openItems === 0` and `!baselineBroken` | else | never |
| **No rework** | `gateCRounds === 0` | `gateCRounds > 0` (the final check sent the team back for a repair round, `src/dispatcher.ts:1887-1891`) | never |

`why` texts (engine):

- Delivered: yes: "All `n` features were built and checked." (`n = 1`: "The feature was built and checked.") · no: "`d` of `t` features were built and checked." then " `s` is stuck." / " `s` are stuck." and " `l` was left out." / " `l` were left out." for those present, or " `u` not finished yet." (paused mission) · `t = 0`: "No features were planned."
- Final review passed: yes: "The final review ran and found no serious problem." · no/`judged false` (the project's own checks were already failing and no test could stand in for them; only for a mission with a feature checked by a second AI, after the other cases): "No final check could judge the result, because the project's own checks were already failing." · no/`reviewed false`: "The final review did not finish, so nobody reviewed the whole app." · no/`ok false` and `baselineBroken` false: "The final tests of the whole app did not all pass." · no/`ok false` and `baselineBroken` true: "The new features' tests did not all pass together on the final result." (with a red baseline the engine judges the final check by that regression run, `src/dispatcher.ts:1873-1877`) · no/`blocking`: "The final review found `b` serious problem(s) that was/were not fixed." · no/not run: "The final check did not run." · unknown: "The result of the final check could not be read."
- Nothing open: yes: "Nothing is waiting for you." · no: the parts that apply joined by a space: "1 item is waiting for you." / "`o` items are waiting for you." (`o = openItems`; the word is "item", never "question", because an item can be a stuck feature, a failed mission or a question) and "The project's own checks were already failing."
- No rework: yes: "The final check did not send the team back for a repair round." plus " `r` feature(s) needed a retry first." when `r > 0` recovered features · no: "The final check sent the team back for a repair round."

`caveat` on Final review passed (the tick's state stays `yes` or `no`; a caveat never changes it). The parts that apply, joined by a space, in this order:

1. `c` = notes of the mission that match `^The review of ".*" did not finish, so it was merged after passing its checks\.$` (`src/dispatcher.ts:1755`); `c > 0` → "`c` feature(s) were merged without their own review." (`c = 1`: "1 feature was merged without its own review."). Approximate: it depends on that note's wording.
2. `dp.finalVerify` exists and `d < t` → "It covered only the `d` features that were built." The final check runs on what is merged; with 2 of 4 features built it reviewed those 2 (verified: the `partial-blocked/` fixture has `finalVerify` `ok`, `reviewed`, `blocking 0` with 2 of 4 features done, so the tick reads yes with this caveat).

The report said to withhold the tick in case 1; this spec keeps the tick and shows the caveat beside it, because the final review of the whole app is a different fact from a feature's own review (5.6 item 10, pending owner).

**A tick is never `yes` on missing data.** What is withheld: an unreadable `dispatch.json` → the tick is `unknown`; no `usage.jsonl` → `agentTimeText` and `agentRuns` are null (nothing is guessed); events are not needed for the ticks.

**Agent time**: sum of `durationMs` of `usage` records with this `missionId`: under 60 s → "less than a minute of AI work"; else "about 35 min of AI work" or "about 2 h 10 min of AI work" (rounded to the minute). `agentRuns` = the number of those records, null when there are none or the ledger is missing.

**Allowance note** (constant): "The AI work runs on your existing Claude and Codex plans, so there is no separate bill. This page cannot show your share of the week yet." **Honesty note** (constant): "These are the AI team's own checks, not a human review." The page also shows the current allowance pills under the heading "Allowance now" (17.1), taken from `allowance.providers`.

---

## 12. Recent and earlier work

### 12.1 Definitions

- `recentStart` = `generatedAt - RECENT_WINDOW_MS` (24 h), **always**. A day is longer than the 18 hours the engine allows for a stop time (`src/run.ts`), so the work of one run is never cut in two. The live run's lock `at` is used for the running time and nothing else. (The report used the lock's `at` while a run is live. A restart in the middle of a run takes a new lock at, say, 03:10 and would then push everything finished since 22:00, with its cards and timeline lines, out of the recent work for as long as the second run is live. 5.6 item 1. The first version of this spec used 18 hours; the owner decided on 24.)
- `hasWorkLeft(m)` is the engine's rule (`src/run.ts:415-417`): `m.stage !== "complete"` and (`m.status !== "failed"` or `m.failure?.retryable === true`).
- `unresolved(m)`: `m.stage !== "complete"`, or (`m.stage === "complete"` and (`decisionsNeeded.length > 0` or any feature `blocked` or `skipped` or `baselineBroken`)).

### 12.2 Scope of each readable mission

1. `worked` = `updatedAt >= recentStart`.
2. `queuedForThisRun` = a run is live and `hasWorkLeft(m)` (the live run re-reads the queue after every mission, `src/run.ts:404-407`, so it will take it).
3. `worked || queuedForThisRun || waitsForCheck` → scope **recent**. `waitsForCheck` = the mission is `stopped` with a `pending` checkpoint: it waits for the owner however long that takes, so its card and its amber lamp reason must not age out after 24 hours. (An `answered` one ages out like any other and goes to the quiet row, which says "You answered. It continues on the next run.")
4. else `unresolved(m)` → scope **earlier** (`openFromEarlier: true`). Three kinds, counted separately:
   - state `needs_you` (status `failed`, stage not `complete`): `counts.earlierNeedYou`. The engine still treats it as open (`src/run.ts:42`, `:420-422`: owner-waiting failed missions are listed even when they did not run in that run; an expired-login failure is retried by the next run). Amber L15, and an amber `mission_failed` card.
   - stage `complete` with a leftover decision, stuck or left-out feature, or `baselineBroken`: `counts.earlierWaitingForYou`. Info L23 only; the colour never changes.
   - any other unresolved mission (queued, paused, or saved busy from a killed run): the quiet row only. The next run takes it (`hasWorkLeft`).
5. else hidden (counted in `counts.olderMissionsHidden`, not in `missions[]`).
6. A mission whose `mission.json` exists but cannot be used (unreadable) is always scope **recent** and counted: unknown data is never green, and its age is not reliable (the brief). A folder with no `mission.json` is not a mission (3.2).

### 12.3 Consequences

- With a live run, a mission queued weeks ago is part of the recent work.
- With no live run, a mission queued or paused more than 24 h ago is "earlier work still open" and does not touch the lamp. An earlier failed mission does: amber, and it stays amber until the owner acts or the next run retries it (an expired login) or finishes it.
- A run that crosses midnight is one run (the window is 24 h, not a calendar day). A restart in the middle of a run does not move earlier items out of the recent work (12.1). The boundary is exact: a mission last saved 23 h 59 min ago and one saved exactly 24 h ago are recent, one saved a millisecond longer ago is earlier (unless a live run still has work for it).
- Only `recent` missions produce lamp reasons L1 to L14 (L10a included) and L16 to L22, timeline lines and debriefs; cards come from them too, plus the earlier failed missions' cards. `earlier` missions show as a quiet row ("Earlier work still open (N)": title, word, sentence and a "Tell the leader about this" button for each mission) and add L15 or L23.
- Two missions with the same title are told apart in sentences by their id (8).
- `missions[]` order: recent first, then earlier; within each, oldest `createdAt` first, then id (the order `mc status` uses, `src/state.ts:152`).

---

## 13. Edge cases

Every row has a test (T-EDGE-n). "Never green": an unknown or unreadable input never produces the `on_track` lamp.

| # | Situation | What the snapshot does |
|---|---|---|
| E1 | The home folder does not exist | No error. Lamp `idle`, sentence "Nothing is running and nothing is queued." `missions` empty, no cards, no timeline, no debrief. Allowance rows say "No usage reading yet." `/healthz` says `"home": "missing"`. HTTP 200. |
| E2 | `missions/` exists and is empty | Same as E1. |
| E3 | The home cannot be read (an error other than "not found", for example the path is a file, or no permission) | Never throws. Lamp `needs_look`, reason `home_unreadable`: "Mission Control's files cannot be read". `/healthz` says `"unreadable"`. |
| E4 | A mission folder whose `mission.json` exists but is invalid JSON, not an object, has the wrong id, lacks a required field (`src/state.ts:303-333`), fails the deep checks (3.2) or is over `MAX_MISSION_BYTES` | Counted in `counts.unreadableMissions`. Appears in `missions[]` with `readable: false`, title = folder name (cleaned), state `unknown`, word "Needs a look", sentence "Its file cannot be read.". Scope `recent` whatever its age (unknown data is never green, brief item 10). Lamp amber (L5) until the file is repaired or the folder removed. A folder with **no** `mission.json` is not a mission and is ignored (E49). |
| E5 | Unknown mission `status` or `stage` | State `unknown` ("Needs a look"); progress all `todo`; sentence "This page does not know this state."; amber (L6). |
| E6 | A feature with an unknown `status` | Feature state `unknown`; amber (L6). |
| E7 | `usage.jsonl` missing or over the cap | No error. Debrief `agentTimeText` and `agentRuns` are null. |
| E8 | `quota.json` missing, unreadable, over the cap, or not an object | Rows "No reading yet" with the note "No usage reading yet."; `fileChangedAt` null. Individual bad entries are skipped; the rest is used. A bad entry includes a time that a date cannot hold (`limits.<p>.until`, `modelBlocks[].until` or `utilization[].resetsAt` beyond ±(8.64e15 - 45 000) ms, the margin the allowance adds) and a utilization above `MAX_UTILIZATION` (a file in the wrong unit). Before this, one such number made `Intl.DateTimeFormat` throw and the whole snapshot became the degraded `home_unreadable` one, hiding a red mission. |
| E9 | Stale lock (mtime `LOCK_STALE_MS` or older) | `run.active` false, `heartbeat: "stale"`. `run.line`: "The last run stopped answering at 03:12." A mission saved busy gives amber L3 for the first `RUN_GONE_GRACE_MS` after its last save, then red L2 and a `run_stopped` card. With none saved busy there is no lamp reason. |
| E10 | The run is in another container (the lock's `host` differs from ours) | Not special: liveness is the heartbeat. The host is never shown. |
| E11 | A mission saved busy (4.2), no lock at all | State `paused` (`unexpected`). Amber L3 (`run_gone_pending`, "Checking whether the run is still going.") while `generatedAt - updatedAt < RUN_GONE_GRACE_MS`; red L2 and the card `run_stopped` after. The lamp is never grey Idle while a recent mission is saved busy, so the mission word ("Paused") and the lamp never disagree. |
| E12 | `mc.lock` content is not a lock (not JSON, `pid` missing or not positive) | `heartbeat: "unreadable"`, not a run (the engine treats it as stale, `src/state.ts:433-445`). |
| E13 | Lock `at` invalid, or in the future of `generatedAt` | `startedAt` null (invalid) or `runningMs` 0 (future); the run line omits the running time when null. |
| E14 | Lock mtime in the future | Age 0, heartbeat `fresh`. |
| E15 | `events.jsonl` missing or empty | No timeline lines for that mission. The now line falls back to waiting or between_steps. |
| E16 | `events.jsonl` ends in a torn line | The line is skipped (`src/util/fs.ts:113-120`). |
| E17 | `events.jsonl` over `MAX_EVENTS_BYTES` | Only the last `EVENTS_TAIL_BYTES` are read, from a line boundary. |
| E18 | `dispatch.json` missing, unparseable or over the cap | Final review tick `unknown` when the mission is complete with a done feature; `inflight` ignored. A readable `dispatch.json` without `finalVerify` is not missing data: the final check did not complete, so the tick is `no`, "The final check did not run." |
| E19 | `dispatch.json` holds `gitSettings` with a push token | Never in the snapshot (T-RO-4). |
| E20 | `STOP` exists | `run.stopRequested` true. With a live run: amber L20. Without: no lamp reason. |
| E21 | `--until` given, no live run | `deadline` null. |
| E22 | `--until` given, live run, time passed | `leftMs` negative, `leftText` "past the stop time". |
| E23 | An open `run.start` but the run is not live (a killed run) | `now` is null. |
| E24 | The open run's label matches no feature of the mission | `featureId` null; text "An AI is building a feature" etc. |
| E25 | `run.start` without `run.end`, followed by `mission.resume` | The resume clears it (1.4): no stale now line. |
| E26 | Two missions with the same title | Tell-the-leader sentences add `(mission <id>)` after the title (8). |
| E27 | Hundreds of old finished missions | Hidden, counted in `olderMissionsHidden`; parsing is cached by size and mtime; one build stays fast. |
| E28 | Hostile strings: markup, bidi controls, zero-width, control characters, a 10 000-character title | Cleaned and capped (3.3); the JSON stays valid; no markup is ever interpreted by the page. |
| E29 | A `waiting` mission with no `limit.wait` event | Asleep (4.2). `WaitInfo` cause `unknown`, `until` 0, text "Waiting. Mission Control cannot tell why." Amber L16: unknown is never green and no time is known. |
| E30 | A `limit.wait` reason that matches none of the three shapes (or has one part that does not) | Cause `unknown`, text "Waiting until 12:59. Mission Control cannot tell why." ("Wed 15:26" when the wait ends on another day, 4.6); amber L16; the raw reason is never sent. |
| E31 | A utilization reading whose `resetsAt` has passed | Dropped. |
| E32 | `utilization > 1` | `overage: true`, `fill: 1`, `usedPercent` above 100. Pill `waiting_reset` for a paced window (`five_hour`, `seven_day`), whose cap is below 1; `nearly_out` for any other window. |
| E33 | A provider other than the configured ones in `quota.json` | An extra row. |
| E34 | Only skipped features, no blocked one | Amber L9 with "left out" wording; no card. |
| E35 | `mc dashboard` with a bad port, bad `--until`, port in use, or missing page | Plain one-line errors, exit 1 (2.5). |
| E36 | Non-GET method, HEAD, unknown path, `/../etc/passwd`, `/%2e%2e/x`, `//x`, a very long URL | 405 with `Allow: GET, HEAD`; HEAD with headers and no body; 404 for the rest. Nothing is read from disk because of a request value. |
| E37 | `updatedAt` is not a date | `createdAt` is used (`createdAt` is validated by `load`). |
| E38 | A feature mission at stage `onboard` | Progress: Plan current. |
| E39 | The builder's `now` is before a lock's `at` or an event's `at` | Durations clamp at 0. |
| E40 | Config unreadable | `builtInSettings()`; `/healthz` says `"settings": "built_in"`. |
| E41 | Saved `waiting`, a `run.start` after the newest `limit.wait` (the agent that follows a wait is running) | The mission is `awake`: state `working`, no `waiting`, no banner, the Now line names the open run, no wait reason in the lamp. Fixture `waiting-then-running/`. |
| E42 | Saved `waiting`, newest `limit.wait` has no later `run.start`, and `generatedAt > until + WAIT_OVER_GRACE_MS` | Not asleep: `working` with a live run, `paused` (unexpected) without. |
| E43 | Status `done` or `partial` with stage `finalize` (or any stage but `complete`) | Busy: `working` ("Landing the work and writing the report.") with a live run; `paused` (unexpected) without, so L3 then L2 apply and the card `run_stopped` appears. Never green or idle. Fixture `finalize-cut-off/`. |
| E44 | A mission saved `running` by an earlier run that was killed, a live run, an older queued mission ahead | While the run has been live for `STALE_BUSY_AFTER_MS` and has not touched it: `paused` (unexpected), sentence "Paused: its earlier run stopped unexpectedly. It continues when its turn comes."; never the worked mission; no lamp reason while the run is live. Fixture `stale-busy-under-live-run/`. |
| E45 | A wait whose reason has a login part | Cause `login`. Amber L11 whatever the length, the card `login_needed`, text "Waiting for allowance until 12:59. Claude also needs a new login." Never "Nothing needs you". Fixture `login-wait/`. |
| E46 | A failed mission last saved 26 h ago (an expired login), no live run | Scope `earlier`, state `needs_you`. Amber L15 "1 earlier mission needs your help", an amber `mission_failed` card, `counts.earlierNeedYou` 1. The lamp sentence never says "Nothing needs you". Fixture `scope-mix/`. |
| E47 | `seven_day` reading 0.9 (cap 0.85), `limits` empty | Pill `waiting_reset`, `limitedUntil` = the reading's `resetsAt`, `limitedText` "Waiting for the weekly limit to reset. Work resumes Thu 09:00." Fixture `quota-paced/`. |
| E48 | A second lock (a restart at 03:10) after a first run that finished some work from 22:00 | The earlier work stays recent: scope, cards and timeline use the last 24 h, not the new lock's `at` (12.1). Test `restart-midnight`. |
| E49 | A folder under `missions/` with no `mission.json` (half-created, or stray) | Not a mission: not in `missions[]`, not counted, no lamp reason. |
| E50 | A mission with 2 of 4 features done whose final check passed | Tick Final review passed `yes` with the caveat "It covered only the 2 features that were built." (11). |
| E51 | A `verify` event `gate-c` with `ok: false` in a mission with `baselineBroken` | Timeline: "The project's own full test suite failed. It was already failing before this work started." (info), not the plain failure sentence (7.1 row 10). |
| E52 | A title, reason or question written with invisible characters (tag characters, variation selectors, fillers) | Cleaned (3.3). The visible text is shown, in the snapshot and in every "Tell the leader" sentence. A title of only invisible characters shows the id. |
| E53 | More missions or cards than the caps | The lists are cut as in 3.2 and counted in `counts.missionsNotShown` / `counts.cardsNotShown`; the lamp covers everything. |
| E54 | A very large home (many features, long reasons, hundreds of events, three-byte characters) | The snapshot is built again with fewer items until its JSON is under `MAX_SNAPSHOT_BYTES` (3.2). |
| E55 | A wait, a reset or a change time 6 days or more from `generatedAt` (a weekly limit hit just after a reset, a `quota.json` a week old) | The text carries the date: "Waiting for allowance until Mon 19 Oct 10:03. It resumes by itself.", "resets Mon 19 Oct 10:03", "Usage figures last changed at Mon 5 Oct 01:38", "The last run stopped answering at Sat 3 Oct 09:58." Five days 23 h 59 min away still names the weekday only. Every text names the same moment (V3). |
| E56 | A mission last saved between 18 and 24 hours ago, no live run | Still recent (the window is 24 h); at 24 h exactly still recent, a millisecond more is earlier (12.3). |

---

## 14. Fixtures

Location: `test/fixtures/dashboard/<scenario>/`. Each scenario is a complete mini Mission Control home, so `new MissionStore(copy)` and the builder run on it unchanged:

```
<scenario>/
  missions/<id>/mission.json
  missions/<id>/events.jsonl
  missions/<id>/dispatch.json      (only where the real mission had one; reduced, see 14.4)
  usage.jsonl                       (where the capture had one)
  quota.json                        (d1 and the multi-mission home only)
```

Only `.json` and `.jsonl` files. No `report.md`, `guards/`, `worktrees/`, `reports/`, `logs/`, no screenshots.

### 14.1 Authentic scenarios (from a capture of the real engine with scripted AIs)

| Fixture | From | Mission | What it pins |
|---|---|---|---|
| `done/` | `raw/a-happy-done` + `_home-final/.../habit-tracker/dispatch.json` (reduced) | Habit tracker, 4 features done | all-done green, four ticks yes, steps 1 of 5, timeline of a clean run, tell templates |
| `partial-blocked/` | `raw/b-partial-blocked` + dispatch (reduced) | Members site: `signup` blocked, `pay-subscription` skipped, 2 done | stuck + left out + one question, the architect's block reason as an AI text, reinforcements (3 of 5), ticks (Delivered no, Nothing open no) |
| `midrun-testing/`, `midrun-building/`, `midrun-reviewing/` | `raw/c1`, `c2`, `c3` (usage included, no dispatch, no lock) | Task board, one feature in progress | the now line from the open `run.start` (`test-add-task`, `build-add-task`, `review-add-task`); working lamp once a lock is added |
| `limit-waiting/` | `raw/d1-limit-waiting` incl. `quota.json` | Reader, waiting at the plan check | `limit.wait`, `WaitInfo` (limits), allowance `waiting_reset` for Codex, no 5-hour wording |
| `limit-then-done/` | `raw/d2-limit-then-done` + dispatch (reduced) | Reader, finished after the wait | the wait inside a finished timeline |
| `failed-auth/` | `raw/e-failed-auth` + `{}` as dispatch | Recipe box, failed, retryable | red lamp, failure card, login translation, a feature `building` in a failed mission shown as Paused |
| `multi-mission/` | `raw/_home-final` (all five missions, `usage.jsonl`, `quota.json`) | five missions | ordering, counts, scoping with different `now` values, hidden old missions |

Honest limits of the authentic data (also in `PROVENANCE.json`): the AI answers, titles and prose are scripted and not representative; durations are milliseconds; no capture has a usage reading, a feature that failed then passed, a `fix-` or `onboard` run, a repair lap, a mid-run `mc.lock`, or a mid-run `dispatch.json`; `quota.json` and `mtime`s do not survive a copy.

### 14.2 Synthetic fixtures (added; marked `synthetic: true` in `PROVENANCE.json`)

Static files (small, shape copied from the authentic ones): `all-event-types/` (one mission whose `events.jsonl` has at least one event of each of the 26 types and sub-cases of 7, plus an unknown type), `hostile-strings/`, `dispatch-with-secret/` (the full original `dispatch.json` shape with `gitSettings.config` containing `ghp_FAKE0123456789SENTINEL`), `quota-readings/` (Claude `five_hour` 0.62 and `seven_day` 0.41, Codex `seven_day` 0.18 only, resets ahead of the test clock), `quota-nearly-out/` (Claude `five_hour` 0.91 and `seven_day` 0.80: a weekly 0.86 is past the 0.85 weekly pause cap and would read `waiting_reset`), `quota-expired/`, `quota-overage/`, `quota-limited/` (Claude `limits` with `kind` `weekly`), `quota-corrupt/`, `unreadable-mission/` (one valid mission and one with broken JSON), `unknown-status/` (mission and feature), `login-wait/`, `trouble-wait/`, `unknown-wait/` (the three `limit.wait` reason shapes and a non-matching one), `recovered/` (a feature done after a failed build attempt), `repair-lap/` (`gateCRounds` 1, feature `gate-c-fix-1`, the stage events and `feature.added`), `final-review-unfinished/`, `final-review-blocking/` (partial with the "Have someone check the app" decision), `final-verify-red/`, `old-dispatch-no-reviewed/`, `feature-review-unfinished-note/`, `baseline-broken/`, `paused-disk/`, `paused-ai-failing/`, `paused-deadline/`, `paused-stop/` (each with a `mission.stopped` event carrying the reason shapes of 4.5; `paused-stop/` is also the fixture of a run that reached its stop time, which writes the same reason), `feature-mission-labels/` (a change mission with `onboard`, `fix-`, `diagnose-` labels), `duplicate-titles/`, `scope-mix/` (missions updated now, 27 h ago and unresolved, 3 days ago and complete, queued 5 days ago). Added after review: `waiting-then-running/` (a mission saved `waiting`, a `limit.wait` and then an open `run.start`), `finalize-cut-off/` (status `done`, stage `finalize`, no lock), `stale-busy-under-live-run/` (an earlier mission saved `running` by a run that was killed, a queued mission ahead of it, and a fresh lock), `quota-paced/` (Claude `seven_day` 0.9 and `five_hour` 0.98 with empty `limits`, Codex 0.30), `restart-midnight/` (events of a first run from 22:00 to 02:00 and a second lock at 03:10), `no-mission-json/` (one valid mission and a folder with no `mission.json`), and an extra mission in `scope-mix/` (failed, retryable, last saved 26 h before the test clock, so it is earlier work under the 24 h window). `baseline-broken/` also carries a red `verify` event labelled `gate-c` and a `gate-c-features` one.

Checkpoints (hand-made from docs/checkpoints-spec.md, section 4, before the engine that writes them existed; `test/checkpoint-dashboard.test.ts` replaces that trust with the real engine's output): `checkpoint-plan/` (a new app stopped before its foundation is built: status `stopped`, stage `init`, a `pending` plan checkpoint with five lines, the events up to `checkpoint.parked`), `checkpoint-feature/` (a change stopped after the review of one feature and before it is added, a `pending` feature checkpoint with a saved name and a commit), `checkpoint-final/` (every feature done, stage `finalize`, a `pending` final checkpoint, a green `finalVerify`), `checkpoint-answered/` (the plan approved, state `answered`, `checkpoint.answered` written, no run since). `PROVENANCE.json` marks all four `synthetic: true` and says so in its honest limits. `src/dashboard/checkpoint.test.ts` is their test.

Programmatic (built in the test from a small builder in `test/dashboard-helpers.ts`, not committed): an empty home, a missing home, `missions/` empty, a home path that is a file, 300 old complete missions, a lock of every age, a corrupt lock, STOP, missing `usage.jsonl`, oversized files, a folder with a transient missing `mission.json`.

### 14.3 Time, locks and modification times

Fixtures are copied into a temp folder before use (`copyHome(name)`); the committed fixtures are never touched. Events in the authentic fixtures are at `2026-10-11T09:58Z`. The default test clock is `2026-10-11T09:58:30.000Z` for mid-run scenarios and `2026-10-11T10:03:30.000Z` (five minutes later) for finished ones. All tests pass `timeZone: "UTC"`.

Mid-run fixtures have no lock file (the capture driver held the lock in memory). `withLock(home, { at, ageMs, now })` writes `mc.lock` = `{"pid":4242,"at":"<at>","host":"mission-control-run"}` and sets its mtime to `now - ageMs` with `utimesSync`; for the mid-run fixtures `at` is the mission's `createdAt` (`2026-10-11T09:58:19.844Z`) and `ageMs` 15 000 (verified in the prototype: running time 10.2 s, heartbeat fresh). `withStop(home)` writes `STOP`. `touch(path, ms)` sets an mtime (for `quota.json`, `dispatch.json`, the job log). Nothing else in a copy is modified.

### 14.4 Neutralising paths and secrets

A one-off script (not committed) copies the files and, on the raw text:

1. replaces the path of the capture home's `.mission-control` folder with `/fixture/.mission-control`;
2. replaces the path of the capture home's `mc-apps` folder with `/fixture/mc-apps`, and the `file://` forms likewise;
3. reduces each `dispatch.json` to `{ "finalVerify": <copied verbatim> }` (or `{}` when the real one has none). Reason: its other keys hold absolute paths and a copy of the app's `.git/config`, and the dashboard reads only `finalVerify` and `inflight`;
4. checks every file parses (JSON, or one JSON object per line) and that none contains `/tmp/`, `claude-0`, `/root`, `/home/user`, `scratchpad` or `capture`.

Affected keys found in the captures: `mission.json` `repoPath`, `integrationWorktree`, `verify` commands' paths; `events.jsonl` `verify.logFile` and `report.path`; `dispatch.json` (dropped). `test/dashboard-fixtures.test.ts` repeats check 4 on the committed files and also fails on any file that is not `.json` or `.jsonl`.

`test/fixtures/dashboard/PROVENANCE.json` records, per fixture: source scenario, engine commit `8342744`, whether authentic or synthetic, the reductions applied, and the honest limits above.

### 14.5 Demo snapshots (generated golden files)

The page must be showable without a server (17.2). The demo snapshots in `dashboard/demo/<name>.json` are **generated, never hand-written**, so their words come from the same vocabulary module as a real snapshot and cannot drift from it. `test/dashboard-demo.test.ts` (agent 1) builds each one from the named fixture below with a pinned clock and `timeZone: "UTC"`, serialises it with `JSON.stringify(snapshot, null, 2)`, and fails when the committed file differs. `UPDATE_DEMO=1 npx vitest run test/dashboard-demo.test.ts` rewrites the files (and `dashboard/demo.html`, 17.2); nothing else writes them. The same test runs `assertSnapshotShape` on each.

| Demo | Built from | Clock | What it shows |
|---|---|---|---|
| `done` | `done/` | capture + 5 min | green, all done, the debrief with four ticks yes |
| `partial-blocked` | `partial-blocked/` | capture + 5 min | amber, one stuck feature, "Not finished", Delivered and Nothing open `no`, the caveat on Final review passed |
| `working-midrun` | `midrun-reviewing/` + `withLock` (`ageMs` 15 000) | capture + 30 s | green, the Now line, running time |
| `waiting-long` | `limit-waiting/` + `withLock` | capture + 30 s | amber long wait, Codex `waiting_reset` |
| `login-wait` | `login-wait/` + `withLock` | its test clock | amber, the login card |
| `failed-auth` | `failed-auth/` | capture + 5 min | red, one card, retryable |
| `multi-mission` | `multi-mission/` | capture + 5 min | five missions, red and amber together, the Needs-you list |
| `allowance-readings` | `quota-readings/` + `midrun-testing/` + `withLock` | its test clock | gauges with pause ticks (synthetic readings; `PROVENANCE.json` says so) |
| `idle` | `emptyHome()` | any | grey, "Nothing is running and nothing is queued." |
| `hostile-strings` | `hostile-strings/` | its test clock | cleaned and capped strings |

The states "Not updating" and "Not responding" belong to the page's own clock, not to a snapshot; the Playwright checks cover them (15).

---

## 15. Test plan

Rule: **one test per lamp rule and one per translation**, plus the groups below. Names are `T-<group>-<n>`. Table-driven (`it.each`) where a table is the spec. Every test passes `now` and `timeZone: "UTC"`; none uses the wall clock.

| Group | What | Where |
|---|---|---|
| T-SHAPE | Every fixture and every synthetic home builds a snapshot that passes `assertSnapshotShape` (JSON round trip identical, no `undefined`/NaN, every enum id in its `as const` list, every `author` valid, ticks length 4, lamp state consistent with `reasons`, no control, bidi or other invisible format characters (3.3), every list within the caps of 3.2, `whatToDo` and the two `NotShown` counts present, size under 200 KB). `schemaVersion` is 1. | `snapshot.test.ts` |
| T-VOC | Every row of the mission table (4.2), feature table (4.3), stage table (4.4), stop table (4.5), sentence table (4.6), wait shapes and texts (4.6), pill words, window labels, verdict words, tick labels, plurals, time formats (`09:58`, `2 h 43 min`, `12 s ago`, `Sun 11 Oct`, `resets Thu 09:00`, `Wed 15:26` for a wait on another day, with the year, month and timezone edges, and "" for a time a date cannot hold); first match wins in the stop table (an AI failure that mentions a deadline is `ai_failing`); `deadlineLeftText` is `0 s left` at the stop time itself and `past the stop time` only after it; every lookup by a file key with `constructor`, `toString`, `__proto__` and `valueOf`; the stop wording never says "on request" or "at the planned time". **Forbidden words**: build every snapshot of every fixture, collect every string whose author is `engine` (lamp sentence and clauses, mission and feature sentences, card `title`, `happened` when engine, `summary`, `ifNothing`, `whatToDo`, timeline `text`, debrief `why`, `caveat`, verdict sentences, allowance texts, `leader.*`), remove every mission and feature title and every `ai` string from them, and assert that none contains, as a whole word and ignoring case: builder, test writer, acceptance, git, crash, crashed, worktree, branch, frozen, gate, escalation, rung, token, objective, "internal error", "mission.json", "repair lap", halted, killed, "AI programs", "the AIs", and the words of the time-of-day row of the glossary (4.0), also inside a longer name; the same check runs on every key of the snapshot JSON and on every enum value of `types.ts` (scopes, lamp reasons, states, kinds). **Typography**: display strings contain no straight `"`; every `tellLeader` and `leader.*Sentence` uses straight quotes and no curly ones. | `vocabulary.test.ts`, `snapshot.test.ts` |
| T-LAMP-L1 … L26 | One test per rule of 5.3 on a named fixture (or a programmatic variant), asserting the reason code, state, word and sentence. Includes the boundaries: heartbeat 119 s fresh / 120 s late / 299 s late / 300 s stale; run gone at 59 s (amber L3) / 60 s (red L2); quiet at 49 min / 50 min; wait 60 min short / 61 min long; asleep at `until + WAIT_OVER_GRACE_MS` and one ms later; a stale-busy leftover at `STALE_BUSY_AFTER_MS` minus 1 ms and at it. Every clause is asserted to contain no ";" and no " and ". A wait three days ahead reads `Waiting for allowance until Wed 10:58. It resumes by itself.` in the lamp, the mission sentence, the Now line, the banner, the timeline and the feature reason, and the allowance rows say the same minute (L17). V3: a wait 8 days ahead reads `Waiting for allowance until Mon 19 Oct 09:58. It resumes by itself.` everywhere, a wait exactly 6 days ahead carries the date and one of 5 days 23 h 59 min does not; the same holds for `Usage figures last changed at ...` (6 days back and 8 days back) and `The last run stopped answering at ...`; the formatter is also tested at 5 d 23 h 59 min 59 s, 6 d and a year apart. A mission saved `waiting` or `running` with no live run (no lock, or a stale one) is amber `run_gone_pending` at 59 999 ms after its last save and red `run_gone` with a `run_stopped` card at 60 000 ms; it is `paused/unexpected`, `allowance.waiting` and the Now line are null, and the lamp is never `idle` or `on_track` next to it (L2, L3). With two long waits the clause names the first mission's (order of `missions[]`). | `lamp.test.ts` |
| T-LAMP-ORDER | Worst wins (red over amber, amber over green); reasons in table order; sentence with one, two and three clauses; "The rest is on track." only when allowed; the green and grey sentences (5.4), including the tail "Nothing needs you." versus "Nothing new needs you. 1 earlier mission still waits for you (see below)." and the grey line with earlier missions; the 5.4 examples verbatim (`1 feature is stuck.` on `partial-blocked/`, `“Recipe box” needs your help.` on `failed-auth/`). | `lamp.test.ts` |
| T-LAMP-NEVER-GREEN | Unknown status, unknown stage, unreadable mission, unreadable home, unknown feature status, a wait of cause `unknown`, a wait with no `limit.wait` event, a wait of cause `login`, `done` or `partial` with stage `finalize` and no lock, an earlier failed mission: none gives `on_track` or a sentence that says "Nothing needs you". | `lamp.test.ts` |
| T-SAN | `clean()` against a per-character table of the invisible set (3.3), a sweep of the whole Cf category, a tag-encoded title, and all-invisible titles that fall back to the id (mission and feature). | `sanitize.test.ts`, `snapshot.test.ts` |
| T-LIMITS | The caps and the size ladder (3.2): the lamp, the counts and the debrief ticks do not change when the lists are cut; a home of many missions, cards, features, long reasons and three-byte characters stays under `MAX_SNAPSHOT_BYTES`; `maxBytes` reaches every smaller try. | `limits.test.ts` |
| T-LAMP-PAGE | The two fixed lamps of `freshness` (`notUpdating`, `notResponding`) are valid `Lamp` objects and carry their codes (`page_stale`, `no_news`). | `snapshot.test.ts` |
| T-NOW | The three mid-run fixtures (agent text with the feature and since); each of the 6 stage labels and 7 prefixes; a dead run gives null; an asleep mission gives `waiting`; between_steps; a label with no feature; a restart boundary clears an open run; interleaved starts and ends matched by `jobId`; `inflight.feature` agrees or fills in; `waiting-then-running/` gives kind `agent` and no `waiting` line. | `missions.test.ts` |
| T-STATE | `asleep`, `savedBusy`, `staleBusy` and the mission table 4.2 row by row: `waiting-then-running/` is `working`, `limit-waiting/` with a lock is `waiting`; `finalize-cut-off/` is `working` with a lock and `paused` (unexpected) without it, with L3 then L2 and a `run_stopped` card; `stale-busy-under-live-run/` shows the leftover as `paused` and the worked mission as the one that owns the open run, and `run.lastActivityAt` follows the worked mission only; `restart-midnight/` keeps the earlier work recent; `staleBusy` does not fire when an event of the mission is at or after the run's start while `updatedAt` is older; "Building feature k of n" counts blocked and skipped features as finished and never shows k above n; `recovered` also holds when the failed build attempt ended `limited` or `error`. | `missions.test.ts` |
| T-TL-01 … T-TL-26, T-TL-UNKNOWN | One test per event type of table 7 (and per sub-case rows: the five stop reasons, the `to` values, the `attempt` cases, the `verify` cases, the `run.end` outcomes), using `all-event-types/`; an unknown type is hidden and does not throw. | `timeline.test.ts` |
| T-TL-SHORT | Rules 7.2: the detail supersede rule, merging with `count`, ordering, the cap and `earlierNotShown`, the 24 hour window (an event 19 h old and one 23 h 59 min old are kept); the exact visible lists for `done/` (10 items from 101 events), `partial-blocked/` (12 from 89), the mid-run fixtures (5) and `failed-auth/` (6). | `timeline.test.ts` |
| T-TL-AUTHOR | `note.author` and `author` for AI and engine texts (the stuck reason from the architect is `ai`; the merge conflict reason is `engine`). | `timeline.test.ts` |
| T-CARD | Each kind (9.1) including `login_needed`, the if-nothing variants, every row of 9.2 and 9.3 (engine vs ai), the dedupe of 9.4 (`partial-blocked/` and `failed-auth/` have no question card), `openItems`, ordering, id stability across two builds, `cardId` links, the earlier failed mission's amber card (`fromEarlier`), no raw `mc ...` command text in any engine field. `whatToDo` per kind (9.1), null for the others; engine-written; no name or quote in it; it names the AI that must log in again. The whole concerns entry must match; text in front of the engine's sentence, or a second copy, makes it an AI text shown in full. **Forged prefix**: an AI-style decision that begins "Have someone check the app before you rely on it:" but fails `CONCERNS_ENTRY` has author `ai`; a real three-shape entry (and a two-part one joined by "; ") has author `engine`. | `cards.test.ts` |
| T-LEADER | Every template of 8 for its card kind, quote replacement, the `(mission <id>)` and `(feature <id>)` suffixes on a collision, the `i of k` numbering with two question cards in one mission (two decisions in one mission never give identical sentences), `leader.canDo` and `leader.stopNote` text, and that no `tellLeader` contains any `ai` string other than the cleaned names. A mission title and a feature title that carry tag characters, variation selectors and fillers give the visible title and the same pasted sentence as without them; a title of only invisible characters falls back to the id. | `vocabulary.test.ts`, `cards.test.ts` |
| T-ALLOW | No quota file; the authentic limits-only file; each pill boundary (0.69, 0.70, 0.89, 0.90); a paced window at its cap (five_hour 0.96 / 0.97, seven_day 0.84 / 0.85) with empty `limits` gives `waiting_reset`, `limitedUntil` and `limitedText` (`quota-paced/`); expired readings; overage; window labels; Codex without a 5-hour window; a mock provider; corrupt files; the waiting banner from each reason shape, and none for an awake mission; `raw` never present; the allowance row's resume minute equals the banner's minute on `limit-waiting/` (both 12:59); a reset, a model block and a file time on another day name the weekday; a time, a provider key or a utilization out of range is a skipped entry (`read.test.ts`). | `allowance.test.ts`, `read.test.ts` |
| T-DEB | Every cell of the tick matrix of 11 (yes, no, unknown) on fixtures; verdicts and the overall verdict, including `partly_done` with every feature done ("Every feature is built, but the final check left something open."); `openItems` and the "item" wording; the caveat parts (unfinished feature review, "It covered only the 2 features that were built."); the red-baseline wording; recovered list; agent time formats; missing ledger; debrief null while working; paused/unexpected excluded; partly done beats paused in the overall verdict. | `debrief.test.ts` |
| T-SCOPE | The six scope rules of 12.2 with a moving `now`; the three kinds of earlier work (failed, finished with leftovers, other) and their counts; the window to the millisecond (23 h 59 min and 24 h are recent, 24 h plus 1 ms and 25 h are earlier); a failed mission 19 h old is still recent and red; the earlier failed mission (26 h old) is amber, never "Nothing needs you"; a folder without `mission.json` is ignored; an unreadable mission is always recent; ordering; counts; hidden missions (`counts.olderMissionsHidden` includes the folders beyond `MAX_MISSION_FOLDERS`); the failed non-retryable mission from 25 h ago under a live run stays `earlier` (amber `earlier_failed`) while the same mission with a retryable failure is recent and red. | `missions.test.ts` |
| T-SRC | Per-field source checks (6) on `done/` and `partial-blocked/`: `featuresTotal` equals the mission's feature count; steps 1 of 5 and 3 of 5; `acceptanceTests`; `isRepair`; `recovered`; `startedAt` equals the lock's `at`; `heartbeatAgeMs` equals `now - mtime`; `deadline` equals `parseUntil`. | `snapshot.test.ts` |
| T-EDGE-1 … 51 | One test per row of 13. | `snapshot.test.ts`, `server.test.ts`, `command.test.ts` |
| T-RO-1 | Read-only proof, snapshot: a copy of `multi-mission/` hashed (file list, sizes, mtimes, sha256) before and after many `buildSnapshot` calls, with a lock and STOP present: identical. | `readonly.test.ts` |
| T-RO-2 | Static scan of `src/dashboard/**/*.ts` (not `*.test.ts`). First check every `openSync(` call for the literal flag `"r"` (this check runs before literals are removed). Then strip comments and string and template literals (so a word in a comment or in prose does not count) and fail on any match of `/\b(?:writeFile|appendFile|mkdir|mkdtemp|rmdir|rename|unlink|utimes|futimes|lutimes|copyFile|symlink|link|truncate|ftruncate|chmod|fchmod|chown|fchown|createWriteStream|writeSync)\w*\s*\(/` and `/\b(?:rm|rmSync|cp|cpSync)\s*\(/`, and on any of the names `acquireLock`, `appendEvent`, `appendUsage`, `requestStop`, `clearStop`, `logsDir`, `createMission`, `ensureDir`, `writeJsonAtomic`, `appendJsonl`, `activeRun`, and `.save(`, `.list(`. Imports: `node:fs` only as named imports from the allow-list of 1.1; no default or namespace import of `fs` or `node:fs`; no import of `fs/promises`, `node:fs/promises`, `child_process` or `node:child_process`; no `require(` and no dynamic `import(`. The words in the contract file `types.ts` are in comments and are stripped. A helper must not be named like a write function: call a text cutter `shorten`, not `truncate`. | `readonly.test.ts` |
| T-RO-3 | Runtime guard: `vi.mock("node:fs")` replaces every write-capable function (and `openSync` with a write flag) with one that throws; a full snapshot build and a full server request cycle complete without a throw. | `readonly.test.ts`, `server.test.ts` |
| T-RO-4 | The sentinel token, absolute paths, `mc run`, backticks, model names and the raw wait reason are absent from the snapshot JSON of every fixture (except `hostile-strings/`, whose AI text may contain such characters, and which is checked for cleaning instead). | `readonly.test.ts` |
| T-RO-5 | Server proof: serve a home copy, request `/`, `/api/snapshot`, `/healthz`, HEAD, POST, 404s many times; the tree hash is identical afterwards. | `server.test.ts` |
| T-SRV | Routes and methods (2.3): body of `/` equals the file; CSP lists the sha256 of every inline script and style and has no `unsafe-inline`; the other headers; JSON type; HEAD has the same headers and no body; 405 with `Allow`; 404; traversal attempts; query strings ignored; `/healthz`; `/favicon.ico`; five concurrent requests share one build inside `cacheMs`; a build that throws gives 500 JSON; `close()` frees the port; port 0 works in tests. | `server.test.ts`, `page.test.ts` |
| T-CLI | `mc dashboard --help`; `mc --help` lists it; bad port, bad `--until`, port in use, missing page: plain messages and exit 1; start and stop; the home comes from `MC_HOME`; the home is byte-identical afterwards. | `command.test.ts` |
| T-DOCKER | The exact `docker run` argument list of 2.6, `:ro`, no other volume, `--entrypoint mc`, `--lan`, a second dashboard refused, help lists `dashboard`, root refused. | `test/mc-docker.test.ts` |
| T-IMG | The Dockerfile contains `COPY dashboard ./dashboard`; `package.json` `files` contains `dashboard`; `dashboard/index.html` exists. | `test/docker-image.test.ts` |
| T-FIXTURE | Fixtures contain only `.json` and `.jsonl`, valid, no absolute path or secret (14.4). | `test/dashboard-fixtures.test.ts` |
| T-PAGE | Static checks on `dashboard/index.html` (no DOM library): one file; no external `http(s)://` or `//` URL, no `<link>`, no `src`/`href` except `#`; no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`; no `style=` attribute; the only `fetch` target is `/api/snapshot`; every id of `LAMP_STATES`, `MISSION_STATES`, `FEATURE_STATES`, `PILL_STATES`, `TONES`, `CARD_KINDS`, `TICK_STATES`, `PROGRESS_STEPS` occurs in the source; has `prefers-color-scheme`, a viewport meta, the `execCommand("copy")` fallback; under 150 KB; contains every string of the "Page words" table (17.1) as a substring; contains the demo hooks of 17.2 (`mc-demo`, `#demo=`); contains every new word of the 17.1 rows (card sections, buttons, bar, sheet, tile, strip, repeats, empty states); the strip under the lamp is chosen from the lamp that is showing (green only in the `on_track` branch, nothing for `idle`); the Needs-you tab's empty line is chosen the same way (the plain line only for `on_track` or `idle`, else the pointer to the Now tab) and is written again when the page's own clock changes the lamp; the strip row and the card use `whatToDo` only when it is set; the first-try tile returns before the steps line, the checks line and the button; the order of the mission groups; a native `details` fold with a keyed `summary`; the Results link row needs `debrief` and no live run; the four tabs Now, Needs you, Timeline and Results in that order, each with its panel; the button words; a header with only the product name and the freshness line; the scope ids of the contract (`recent`, `earlier`) and the quiet row's count `counts.openFromEarlier`; the AI label once for the story lists; an AI-written line is put in curly quotes through one function that leaves a line alone when it already starts with an opening mark or ends with a closing one (the test runs that function on both kinds of line); the live lines are skipped at the Not-responding level; `.gone` has an opacity of at least 0.9; the Copy gate; the Stop button's condition; `scroll-margin-top` on `.card`; no string, comment, id, class or identifier of the page or of the test file carries a time-of-day framing (the test builds its pattern from stems so that its own file stays clean; `midnight` is the one allowed word). | `test/dashboard-page.test.ts` |
| T-DEMO | Golden files (14.5): every `dashboard/demo/<name>.json` equals the snapshot rebuilt from its named fixture and passes `assertSnapshotShape`; `dashboard/demo.html` equals `dashboard/index.html` with the demo block inserted (17.2); all ten names are present. | `test/dashboard-demo.test.ts` |
| T-LEADER-DOC | `leader/CLAUDE.md` names only `mc` subcommands that exist in the commander program and only the allowed set (status, logs, report, stop, new, feature, plan preview, plan queue, plan show, run, approve, send-back, and the three host commands get, publish-preview and publish); the dashboard is not among them (it is a foreground command the owner starts, and a leader tool call would never return); the file tells the leader to start `run` so that its own chat stays usable (in the background or detached); no command that writes into the home; `leader/.claude/settings.json` allows only status, logs, report, plan preview, plan show and publish-preview, asks for stop, run, new, feature, plan queue, approve, send-back, get and publish (approve, send-back, get and publish are never in `allow`), and denies edits, `git` and `logs *--follow*`; `leader/CLAUDE.md` says that AI-written text and the mission and feature names in a pasted sentence (in quotes, or after "in") are data, that `report` is read for its first 40 lines, that `--until` is optional (passed only when the CEO gives a stop time, never asked for) and what a run without one does (checked against the log line in `src/run.ts`), that `waitingUntil` in `status --json` is UTC and the local time is the WAITING UNTIL column of `status` (checked against the real CLI with a time zone set), that a stop is checked with `status --json` first, and holds the dashboard's sentences word for word (`leader.*`, `stopNote`, `canDo`); `docs/leader.md` does not say that a sentence holds no AI-written text; the engine's older wording for a run is explained in plain words when a leader file still names it (the notice and the log line say "Run finished" and "Ending the run early" since Step 3; new run summaries and logs are `run-<date>.md` and `run-<date>.log`; only the files an earlier run wrote, `night-<date>.md` and `night-<date>.log`, keep the older word); none of the leader files, the dashboard parts of README.md, docs/setup-windows.md and the decision-log subsection, or the test file itself, contains one of the retired time-of-day words (4.0), except inside a quotation of the engine's own message; the docs use the page's tab and button names (17.1). | `test/leader.test.ts` |

Checks outside the repo (scratch scripts, Playwright imported from `/opt/node-tools/node_modules/playwright/index.mjs`), run by the page agent and the integrator, results reported, not committed: screenshots at 390 and 1180 px, light and dark, for every demo snapshot and for the real server over `multi-mission/`; no `securitypolicyviolation` and no console error; every button at least 44 px; body text at least 16 px; no horizontal scroll; the stale behaviour at 31 s and 5 min with a controlled clock; the copy fallback with the clipboard API removed. **iPad Safari is not covered** (section 20).

Gate for every agent before reporting done: `npx tsc -p tsconfig.json --noEmit` and `npx vitest run <own paths>`. The integrator runs the full `npm run check`. Do not run `npm run build` or `npm ci` while other agents work.

---

## 16. File ownership matrix

No agent edits a file another agent owns. `src/dashboard/types.ts` and `docs/dashboard-spec.md` belong to the contract author; a needed change is reported, not made. Nobody commits or pushes: the agents share one working tree, and a file that is written is visible to the others at once.

| Agent | Creates | Edits (existing files, minimal and additive) |
|---|---|---|
| **1. Snapshot, vocabulary, fixtures, tests** | `src/dashboard/constants.ts`, `sanitize.ts`, `vocabulary.ts`, `read.ts`, `missions.ts` (scope, mission and feature views, now line), `cards.ts`, `lamp.ts`, `timeline.ts`, `allowance.ts`, `debrief.ts`, `snapshot.ts`; their `*.test.ts` in `src/dashboard/` (`sanitize`, `vocabulary`, `read`, `missions`, `cards`, `lamp`, `timeline`, `allowance`, `debrief`, `snapshot`, `readonly`); `test/dashboard-helpers.ts` (signatures in 2.2); `test/dashboard-fixtures.test.ts`; `test/dashboard-demo.test.ts`; `test/fixtures/dashboard/**` incl. `PROVENANCE.json`; the generated `dashboard/demo/*.json` and `dashboard/demo.html` (14.5, 17.2) | none |
| **2. Server, CLI registration, packaging, Docker script** | `src/dashboard/server.ts`, `page.ts`, `command.ts` and `server.test.ts`, `page.test.ts`, `command.test.ts` | `src/cli.ts` (register the `dashboard` command and its action, which calls `lenientStore` and `command.ts`; nothing else, 2.5), `package.json` (`files` only), `docker/Dockerfile` (the `COPY dashboard ./dashboard` line only), `scripts/mc-docker.sh` (the `dashboard` subcommand and its `usage()` line), `test/mc-docker.test.ts` (new cases), `test/docker-image.test.ts` (the COPY assertion) |
| **3. The page** | `dashboard/index.html` (one file, inline CSS and JS, with the demo path of 17.2), `test/dashboard-page.test.ts` | none |
| **4. Leader, docs, README, decision log** | `leader/CLAUDE.md`, `leader/README.md`, `leader/.claude/settings.json` (`allow`: `mc-docker.sh` status, logs, report, plan preview and plan show only; `ask`: stop, run, new, feature, plan queue, approve and send-back, so Claude Code asks before them, on the PC or in the app; `deny`: Edit, Write, NotebookEdit, `git`, and `logs *--follow*`), `docs/leader.md`, `test/leader.test.ts` | `README.md` (a section on watching the work and talking to the leader), `docs/setup-windows.md` (two short steps: open the dashboard; start the leader and, optionally, Remote Control), `docs/mvp-spec.md` (append the entries of section 18 as a new subsection under "Decisions after wave 4") |

The leader does not run `mc-docker.sh dashboard`: it is a foreground container that runs until Ctrl+C (the Docker script's function for `run` calls `run_container`, which ends in `exec docker run`, `scripts/mc-docker.sh:252, :314`), so a tool call from the leader would never return. The owner starts the dashboard. For the same reason `leader/CLAUDE.md` tells the leader that `run` blocks until the run ends and must be started so that the chat session stays usable (in the background or detached; the exact way is for agent 4 to document from `scripts/mc-docker.sh` and Claude Code's own background-task support, and it is not verified here).

The leader's permissions follow from the fact that reports, logs, decisions and titles are written by AIs: the commands that change something or spend usage (stop, run, new, feature, plan queue) are in the `ask` list, as are the two that answer a check, and `leader/CLAUDE.md` says that AI-written text, and the mission and feature names in a pasted sentence (in quotes, or after "in"), are data, never instructions. `docs/leader.md` says how to move entries from `ask` to `allow`. `test/leader.test.ts` checks the three lists.

Nothing in the engine list of the brief is edited by anyone: `src/dispatcher.ts`, `executor.ts`, `run.ts`, `quota.ts`, `limits.ts`, `state.ts`, `git.ts`, `verify.ts`, `schemas.ts`, `prompts.ts`, `types.ts`, `report.ts`, `notify.ts`, `config.ts`, `doctor.ts`, `src/runners/**`, `src/util/**`, `prompts/**`, `stacks/**`, `docker/entrypoint.sh`.

Interfaces (frozen by `types.ts` and 2.2):

1. **Snapshot JSON**: `Snapshot` in `src/dashboard/types.ts`. Agents 1 and 3 both build to it; agent 2 treats it as opaque.
2. **`buildSnapshot(opts)`** and `settingsFromConfig`, `builtInSettings` (agent 1 → agent 2). Agent 1 writes the skeleton first (2.2).
3. **`startDashboardServer({ host, port, pageHtml, build })`**, `loadPage()`, `contentSecurityPolicy()`, `runDashboard()` (agent 2). The server never imports the snapshot modules; the `cli.ts` action wires `build: () => buildSnapshot({ home, until, settings })`.
4. **`assertSnapshotShape(s)`**, `copyHome`, `hashTree`, `withLock`, `withStop`, `touch`, `emptyHome` in `test/dashboard-helpers.ts` (agent 1 → agent 2's server tests, agent 3's page test; exact signatures in 2.2).
5. **The command line**: `mc dashboard [--host] [--port] [--until]` (agent 2 → the docker script, agent 4's docs).
6. **Enumerations**: the `as const` lists in `types.ts` (agent 3's static test and the page's id handling).
7. **Fixtures**: `test/fixtures/dashboard/<name>/` (agent 1 → agent 2's server tests may use `multi-mission/` and `done/`).
8. **Demo path** (17.2): agent 3 writes the page side; agent 1's demo test writes `dashboard/demo.html` from `dashboard/index.html` with `UPDATE_DEMO=1`, so it needs agent 3's page first. Until the page exists, the demo test is skipped with a message.

Order and priority. Agent 1 is the critical path: agents 2 and 3 do not need its real code, only the skeleton of step 1, but the integrator needs all of it. Agent 1 works in this order: (1) `constants.ts`, the `snapshot.ts` skeleton, `assertSnapshotShape`, `test/dashboard-helpers.ts`; (2) `sanitize`, `vocabulary`, `read`, `missions`, `cards`, `lamp`, `snapshot` with the seven authentic fixtures and the tests of the lamp rules, the states, the cards and the read-only proofs; (3) `timeline` for the 14 event types that occur in the captures, `allowance`, `debrief`, then the synthetic fixtures and their tests, the 12 rarer event types, and last the demo goldens. If the integrator splits agent 1 in two, the line is the one in 2.2 (the three modules `timeline.ts`, `allowance.ts`, `debrief.ts` and their fixtures on one side), and the types and function signatures there are what the two sides share. Agents 2, 3 and 4 start at once. The integrator then runs the checks in section 15.

---

## 17. What the page must do (for agent 3)

The page is dumb: it lays out strings. It owns only the chrome words of 17.1 (tab names, headings, button labels, empty states, the tick state words) and the mapping from state ids to icons and colours. Everything that names a state or says something about the data is a snapshot string. Every chrome word in 17.1 is an exact string that T-PAGE looks for in the file, so the same word appears on every screen.

- One file, inline CSS and JS, system font stack, light and dark by tokens (reuse the tokens of `mockup/mission-control-ceo-view.html`), works at 390 and 1180 px, status is icon plus word plus colour, touch targets at least 44 px, body text at least 16 px, no web fonts, no CDN, no emoji, inline SVG icons.
- Insert every string with `textContent`. Never `innerHTML` and its relatives. No inline `style=` attributes (the CSP forbids them); use classes and the CSSOM for widths.
- Views: **Now** (lamp: word, sentence, `run.line`, `run.activityLine`, the now line `Now: <now.text> (<now.sinceText>)`; the heading `counts.featuresLine`; features grouped by mission, one tile per feature with `word`, `reason`, the steps and reinforcements line of 17.1, the "Recovered after a retry" mark, `acceptanceTests`, the repair tag; the Needs-you strip (under the lamp: the strip, whose second line is `whatToDo` or the first sentence of an engine-written `happened`; a link row `Results are ready` to the Results tab when `debrief` is not null and no run is live), the mission groups in the order needs your help, then stuck or partly done or with a card, then working, waiting, paused, done, not started (the page orders them; `missions[]` is unchanged), a finished mission folded behind "All N features done (show)"; the allowance line; the quiet row "Earlier work still open (N)"), **Needs you** (cards), **Timeline** (grouped by day, then by mission), **Results** (verdict, got, not finished, four ticks with state word, `why` and `caveat`, `plannedLine`, agent time, current allowance, the two notes). The progress line draws the five steps; the checks are never drawn as holds.
- Every `Said` with `author === "ai"` is shown as quoted text with the label from `leader.aiNotice`. In a list of short AI-written stories (the debrief's "What you got" and "Recovered after a retry") the label appears once at the top of the list and each story is a plain quoted line. Everywhere else (a stuck feature's reason, a card's `happened`, the debrief's "Not finished", a timeline note) each AI text keeps its own box and label. Names (titles) are plain.
- Honest game layer only: the lamp, tiles, pips, the recovered mark, the four ticks. No points, XP, levels, streaks, confetti, percent bars, dollars or model names.
- **Tell the leader about this** on every card and every tile that is not a first-try Done tile, and **Tell the leader anything** on the one global bar. Each opens a sheet (titled Tell the leader) with the quick phrases, a free-text box, the ready sentence as a read-only preview and Copy, `leader.canDo` as small text under the sentence, and the paste hint. `navigator.clipboard` may be absent on plain http: fall back to selecting the text and `document.execCommand("copy")`; if that fails show `leader.copyFailHint`. "Stop the current run" opens the same sheet with `leader.stopSentence` and `leader.stopNote` above it; it is not a button that acts. It is shown only while `run.active` is true or `run.stopRequested` is set; with nothing to stop the bar has the one button "Tell the leader anything". The sheet is a column with a scrolling body and a footer that always shows the status line, Copy and Close. Never invent options or Go/No-Go buttons for a decision.
- Polling: `fetch("/api/snapshot", { cache: "no-store" })` every `freshness.pollEveryMs` (default 4000 before the first answer). Keep the last good snapshot. Staleness rules of 5.5 on the page's own clock. "Updated hh:mm:ss (N s ago)" ticks every second. Keep an open sheet and its text across polls; do not move focus on a poll.
- `lang="en"`, title "Mission Control", `aria-live="polite"` on the lamp sentence, reduced-motion respected, keyboard operable.

### 17.1 Page words

These are the only words the page writes itself. Each exact string must appear in `dashboard/index.html`; parts in `<...>` or with digits are filled in at run time, and T-PAGE looks for the fixed fragments around them.

| Where | Exact words |
|---|---|
| Tabs | `Now`, `Needs you`, `Timeline`, `Results`. The Needs-you tab appends the number of cards in brackets when it is above 0: `Needs you (2)`. |
| Header | The product name `Mission Control` and the freshness line `Updated hh:mm:ss (N s ago)` with `freshness.notUpdatingText` beside it. Nothing else: no run title and no date. |
| Needs-you tab, top line | `These are the things the AI team could not settle alone.` |
| Lists the snapshot cut (3.2) | Under the missions when `counts.missionsNotShown` is above 0: `1 more mission is not shown. The lamp above counts it.` / `<n> more missions are not shown. The lamp above counts them.` Under the cards when `counts.cardsNotShown` is above 0: `1 more thing for you is not shown. The lamp on the Now tab counts it.` / `<n> more things for you are not shown. The lamp on the Now tab counts them.` |
| Card of a check (9.1) | An eye icon (`checkpoint`), the heading `What to look at` over the card's `lines` (one label, `leader.aiNotice`, then each line quoted), and two more buttons before the usual one: `Tell the leader: approve` and `Tell the leader: send it back`, drawn only when the card has `answers`; the usual `Tell the leader about this` follows, as the quiet one. They are buttons that open the sheet, like every other: the page still sends nothing. |
| Card sections | `What happened`, `What to do`, `If you do nothing`. `What to do` is drawn only when the card's `whatToDo` is not null, between the other two. The mock-up's "Why it matters" is not built: no field says why something matters (report gap 2). |
| Card, tile and bar buttons | Card and tile (and the buttons of the quiet row and of each mission in the Results tab): `Tell the leader about this`; on a stuck tile that has a `cardId` also `Open the question` (switches to the Needs-you tab and scrolls to that card, which sits 16 px below the top edge). A first-try Done tile has no button. |
| Global bar | `Tell the leader anything`; `Stop the current run` (only while a run is on or a stop was asked for; it opens the sheet and does nothing else). |
| Sheet | title `Tell the leader`; first line `This page cannot send messages. Pick or type an answer, tap Copy, then paste it into your chat with the leader.` (a sentence with nothing to fill in, the approval: `This page cannot send messages. Tap Copy, then paste the sentence into your chat with the leader.`, with no quick answers and no box for words, and Copy enabled at once) (stop sheet: `This page cannot stop the run. Tap Copy, then paste the sentence into your chat with the leader.`); quick-phrase group label `Quick answers`; text box label `Add your own words` and placeholder `Type here (optional)`; preview label `Your message (preview)`; buttons `Copy` and `Close`; Copy with nothing chosen: `Choose a quick answer or type your own words first, then tap Copy.`; after a successful copy `Copied. Paste it into your chat with the leader.`; the hint and failure text come from `leader.pasteHint` and `leader.copyFailHint`. Order in the sheet: first line, quick answers, own words, preview, paste hint, `leader.canDo`. |
| Tile, steps | Drawn only when the feature has been tried (`steps.used` > 0) and either `reinforcements` > 0 or the state is `stuck`, `being_built`, `being_reviewed` or `paused`. `Reinforcements called in: none (1 of 5 steps used)` when `reinforcements` is 0; `Reinforcements called in: 2 (3 of 5 steps used)` otherwise (the numbers are `reinforcements`, `steps.used`, `steps.total`); the pips fill `steps.used` of `steps.total`; below it `steps.caption`. On a `done` tile (recovered) the words are `Reinforcements called in: 2` with no "steps used" part, the pips show only the tries used, and `steps.caption` follows. |
| Tile, other | `Recovered after a retry`; `Repair feature` (when `isRepair`); `Built and checked on the first try.` (a `done` tile with `reinforcements` 0 and not `recovered`: this one line replaces the steps line, the pips, the caption, the checks line and the button); `1 check written for this feature` / `2 checks written for this feature` / `No checks written for this feature` (`acceptanceTests`, which counts files) on every other tile. **A feature checked by a second AI** (the optional `FeatureView.modeChecks` is present; docs/modes-spec.md, 11.5) never gets these words, because no test file stands behind it: its first-try tile reads `Built on the first try.` and, under it, the words of `FeatureView.checkedBy` (the same short words as the Results page, such as `Checked by a second AI against your list; approved by you`); every other tile of it shows `checkedBy` when it is done and `1 check on your list` / `4 checks on your list` (`modeChecks`) otherwise, in the place of the checks line. `test/modes-tiles.test.ts` draws the page in a browser from snapshots of the real engine and fails on `checked on the first try`, `Built and checked` or `No checks written` in such a tile |
| Progress line | the five words from the snapshot (`Plan`, `Plan check`, `Build`, `Final check`, `Landed`); when `repairLap` the Build step also reads `repair round`; the current step of a mission in state `needs_you` is drawn with the red mark and the caption `Stopped here`, and of a `paused` mission with the pause mark and `Paused here`, instead of the working mark |
| Now | the allowance heading `Allowance (how much of your plans is used)`; the pacing tick label `work pauses here`; the quiet-row heading `Earlier work still open (N)` (N is `counts.openFromEarlier`; the row lists the missions whose `scope` is `earlier`, and every other mission is in the main list); a mission in state `done` among the missions shows its head and, instead of its tiles, the control `All N features done (show)` (`The feature is done (show)` for one feature; `(hide)` while open), a native `details` element opened with Enter or Space that stays open across redraws; a done mission among several shows no steps line and no count line |
| Now, under the lamp | The strip. With cards: the rows (title, second line = first sentence of `whatToDo.text`, else of `happened.text` when its author is `engine`, else none). With no cards it depends on the lamp that is showing: `on_track` keeps the green check line `Nothing needs you right now.`; `idle` shows nothing; any other lamp (needs a look, needs you now, not responding, and the page's own "Not updating") shows `Nothing for you to decide. See the note above.` in muted text with no check icon. Then, when `debrief` is not null and no run is live, a link row `Results are ready` that switches to the Results tab. |
| Now, repeats | A text that is already on the screen is not said again: the Now line is dropped when it equals the lamp sentence, and a mission's sentence is dropped when it equals the lamp sentence or the Now line, or when a `needs_you` mission already has its card. With no mission planned, the heading `<featuresLine>` is dropped and only `No missions yet. When one is queued it appears here.` shows. When the only missions are earlier ones (scope `earlier`), neither the heading nor that line shows: the quiet row "Earlier work still open (N)" is the whole answer. |
| Timeline | day headings from `day`; a merged item reads `<text> (3 times)` for `count` 3; when `earlierNotShown > 0`: `Earlier events are not shown (N).`; an item with an AI note shows the note quoted with `leader.aiNotice` |
| Results | the verdict word and sentence; headings `What you got`, `Not finished`, `Recovered after a retry`, `How it went`, `Allowance now`; `plannedLine` beside the ticks; `agentTimeText` and, when `agentRuns` is not null, `(N AI runs)`; the two notes `debrief.allowanceNote` and `debrief.honestyNote` |
| Tick state words | always shown beside the tick's label and icon: `yes` → `Yes`, `no` → `Not this time`, `unknown` → `Could not tell`. A cross next to "No rework" would read as a double negative, so the state word is the answer and the icon only supports it. |
| Empty states | no missions (`missions[]` is empty, so none recent and none earlier): `No missions yet. When one is queued it appears here.`; no cards: `Nothing needs you right now.` when the lamp is green (on the Needs-you tab also when it is grey Idle; on the Now tab grey Idle shows nothing); with any other lamp (amber, red, not responding, and the page's own "Not updating") `Nothing for you to decide. See the note above.` on the Now tab and `Nothing for you to decide. See the note on the Now tab.` on the Needs-you tab, which is written again when the page's own clock changes the lamp; no timeline: `Nothing has happened yet.`; no results: `Results appear when work has finished or paused.` |
| Errors | `This page and Mission Control are different versions. Reload the page.` (when `schemaVersion` is not 1); `Cannot reach Mission Control.` (the first fetch failed; retries keep running) |
| Demo (17.2) | the banner `Demo data. This is not live.` |

### 17.2 Showing the page without a server

The page must be showable from a file, with snapshots that come from the authentic scenarios. The production page and the demo page are the same file apart from one data block.

- `dashboard/demo.html` is **generated**: `dashboard/index.html` with this block inserted immediately before its first `<script` tag: `<script type="application/json" id="mc-demo">{ "<name>": <snapshot>, ... }</script>`, holding the ten snapshots of 14.5. Any `<` in the JSON is written `<`. `test/dashboard-demo.test.ts` writes it (`UPDATE_DEMO=1`) and fails when it differs (T-DEMO). Open it with `file://.../dashboard/demo.html#demo=partial-blocked`.
- Demo mode starts when `document.getElementById("mc-demo")` exists. Then: no `fetch` and no polling; the page reads the block with `JSON.parse`; `location.hash` `#demo=<name>` (default `done`) picks the snapshot, and a change of the hash re-renders without a reload; the page's clock for "Updated" and for staleness is frozen at the snapshot's `generatedAt`, so the stale and not-responding lamps do not fire; the banner `Demo data. This is not live.` is fixed at the top, with ten links (`#demo=<name>`, labelled with the name, hyphens as spaces) to switch. Tell the leader and Copy work as usual.
- The production `index.html` never contains the block, so none of this runs there. T-PAGE checks that the file contains the hooks `mc-demo` and `#demo=`; the Playwright checks of 15 also open `demo.html` for each name.

---

## 18. Decision-log entries (for `docs/mvp-spec.md`, appended by agent 4)

Append under "Decisions after wave 4" as `### CEO dashboard and the leader`, numbered like the others:

1. **A read-only dashboard exists** (`mc dashboard`; design-v1's "Later" item). It serves `GET` and `HEAD` only (anything else is 405) and builds a snapshot from files Mission Control already writes. It never writes, creates, locks or touches anything under the Mission Control home. It uses `MissionStore.load` for each `mission.json` and reads the rest directly with read-only calls (`mc.lock`, `STOP`, `quota.json`, `usage.jsonl`, `events.jsonl` and a few values of `dispatch.json`: `finalVerify` and `inflight`). It never calls `list()` (it hides unreadable missions), `activeRun()` (it probes a pid), `readEvents`, `readUsage`, `stopRequested` or `logsDir()` (which creates a folder). The read-only proof (every write blocked, tree hash unchanged, `strace` showing only `O_RDONLY`) was run on the first prototype of these reads; the shipped reads are covered by `src/dashboard/readonly.test.ts` and by the home-unchanged check. In Docker it runs in its own container with the `mc-home` volume mounted read-only.
2. **No authentication, by the owner's decision.** No token, cookie, CSRF protection, rate limit or second container. Kept: every displayed string is inserted with `textContent`; fixed routes only; a strict Content-Security-Policy that lists the hashes of the page's inline script and style; the listen address and port are options (default `0.0.0.0` inside the container, port 8787; the Docker script publishes on the loopback address unless `--lan`). This supersedes the token-gate and two-container parts of the assessment's section 6.
3. **The dashboard is the CEO's eyes only; the leader is the hands.** The leader is a Claude session in `leader/` (also reachable from the Claude app or claude.ai/code through Remote Control when started with `claude --remote-control`, not verified) that acts only through `mc`: status, logs, report, stop, new, feature, run, approve, send-back. Its permissions auto-allow only status, logs and report; stop, run, new, feature, approve and send-back are in the `ask` list; file edits, git and `logs --follow` are refused. The page has no write path: "Tell the leader about this" and "Tell the leader anything" give a ready sentence to paste, and "Stop the current run" opens a sheet with a sentence to paste, not a button that acts. The leader has no command to reopen a feature or change a plan in place, and the sheet says so. This replaces the assessment's inbox and directive design (Phases 3 and 4), which is out of scope.
4. **One vocabulary, built on the server.** `src/dashboard/vocabulary.ts` holds every word and sentence; the snapshot (`src/dashboard/types.ts`, schemaVersion 1) carries stable state ids plus the plain word; the page only lays strings out and owns a short fixed list of chrome words. Text written by an AI is marked `author: "ai"` and labelled on the page. A text counts as the engine's only when it matches a known engine string in full; the default is `ai`.
5. **The lamp rules are a fixed table with named constants** (`docs/dashboard-spec.md`, section 5). Liveness is the lock's heartbeat alone (5 minutes, the engine's own number for a run in another container), never a pid probe. A mission is "recent" when it changed within the last 24 hours (`RECENT_WINDOW_MS`), or a live run will work on it, or its file cannot be read; every other mission that is still open is "earlier". The window is 24 hours by the owner's decision (a first version used 18 hours, the engine's longest stop time). A saved `waiting` status is not proof that the run sleeps (the engine leaves it while the agent runs after the wait), and `done` or `partial` is not finished before the stage is `complete`; the dashboard decides both from the events and the stage. A failed mission from earlier work turns the lamp amber; other earlier items are shown in a quiet row and never change the lamp (the engine never clears a decision on a finished mission). A queued mission is grey, not amber. A wait of unknown cause, or with a login problem, is amber whatever its length. A stale page turns amber after 30 s and "Not responding" after 5 min; unknown or unreadable data is never green. The places where this differs from the assessment are listed in section 5.6 and are open for the owner to confirm.
6. **Nothing was added to the engine, so some things are approximate or absent**: no stop time unless `mc dashboard --until HH:MM` is given; no share of the week used by this run (memory only); allowance readings carry no time, so the page shows when the figures last changed, from the file's modification time; the wait cause is read from the shape of the `limit.wait` reason; the feature of a running step is read from its label. Each of these is stated on the field in `types.ts`.
7. **The results have four honest ticks**: Delivered, Final review passed (from `dispatch.json` `finalVerify`; `unknown`, never `yes`, when that file cannot be read; a caveat when a feature's own review did not finish or when the review covered only the features that were built), Nothing open (counted from the open items, so a stuck feature or a failed mission is never "nothing"), No rework. They are the AI team's own checks, not a human review, and the page says so. Also: "Reinforcements called in" (tries after the first, with the ladder steps used of its size shown beside it) and "Recovered after a retry". Not built: points, XP, levels, streaks, confetti, percent-complete bars, dollar amounts, model names on the main views.
8. **Packaging**: the page is `dashboard/index.html` at the package root, found with `packageRoot()` like `prompts/` and `stacks/`; the Dockerfile copies the folder and `package.json` lists it in `files`. The dashboard container bypasses `docker/entrypoint.sh` (it would warn about the read-only home). `dashboard/demo.html` and `dashboard/demo/*.json` are generated from the fixtures, so the page can be shown from a file.
9. **Tests use authentic data**: fixtures under `test/fixtures/dashboard/` come from the real engine run with scripted AIs (captured on commit `8342744`), with absolute paths replaced and `dispatch.json` reduced to the one key the dashboard reads; synthetic fixtures cover what no capture contains and are marked as such.
10. **Not verified, and the docs must not claim otherwise**: Docker Desktop and WSL2 networking to a browser or an iPad, iPad Safari, `claude --remote-control` and `/remote-control`, the leader's behaviour in a real Claude Code (including its permission rules and `mc run` as a background task of its session), and any real AI output (every capture comes from scripted stand-ins; none holds a usage reading). The asleep, finalize, heartbeat and kill rules were checked live with the real engine and scripted AIs, not with real AI output.

---

## 19. Out of scope

- Anything that writes or acts from the page: buttons that change the work, an inbox, directives, queueing work, "retry with my answer", pause, drop, reorder, plan approval, a chat box with a model behind it.
- Authentication, tokens, cookies, CSRF, rate limits, TLS, Tailscale or tunnel setup, port forwarding advice, a second container for security.
- Screens other than Now, Needs you, Timeline and Results: Mission map and Crew and fuel are not built.
- Engine changes: a saved deadline (`run.json`), a `verify.start` event, a structured cause on `limit.wait`, a feature field on `run.start`, timestamps on allowance readings, a saved per-run baseline, "review ran" events, a screenshot per feature, structured decisions with options, alert rules and ntfy click links, fixing `mc logs`.
- `mc brief`, an upgraded `mc status --json`.
- A first-try badge, a clean-review badge, a finish-time estimate, this run's share of the week, any percent-complete bar, dollar amounts, model names or token counts on the main views, points, XP, levels, streaks, confetti.
- Proof screenshots and serving any file from the home.
- History beyond the recent work and "earlier work still open"; search; a dismiss button for old items.
- Streaming (SSE, WebSockets), push to the page, service worker, offline mode, install prompts, an app icon.
- More than one home, more than one language, a settings page.
- Windows-native (non-WSL) support, running without Docker is possible but untested.

---

## 20. Not verified, and decisions to confirm

### 20.1 Not verified

Said plainly; none of these may be claimed to work.

- **WSL2 and Docker Desktop networking.** That `--publish 127.0.0.1:8787:8787` reaches a Windows browser, and that `--lan` reaches an iPad through the Windows firewall, was not tried. No Docker is available in the build session, so the `mc-docker.sh dashboard` command is tested only against the fake `docker`: the argument list, not the behaviour. That a `--read-only` root file system plus a `:ro` volume and `--entrypoint mc` let `mc dashboard` start was not run.
- **iPad Safari.** Layout at 390 and 1180 px, the CSP with script and style hashes, the `execCommand("copy")` fallback on plain http, `file://` demo pages and "Add to Home Screen" are checked only with desktop Playwright, if at all.
- **Remote Control.** That `claude --remote-control "Leader"` (one session usable on the PC and in the Claude app under the Code tab, or at claude.ai/code) shows the leader session was not tried. `claude remote-control` is server mode: its own session, which cannot be typed to in that terminal; it is not the leader's way in. It needs a claude.ai login (API keys are not supported; on Team or Enterprise an Owner must enable it) and asks for a one-time "Enable Remote Control" confirmation (the question "Enable Remote Control? (y/n)" in server mode, a dialog in a running session) and a one-time folder trust ("Trust <directory>? [y/N]" in server mode). These facts are from Anthropic's Remote Control documentation, not from a run. The leader's behaviour with the `allow`/`ask`/`deny` lists is untested against a real Claude Code (including that `Bash(../scripts/mc-docker.sh logs *--follow*)` catches both argument orders, and that the `ask` prompts reach the app), and so is running `mc-docker.sh run` in the background from a Claude Code session.
- **Real AIs.** Every capture comes from scripted stand-ins: real wording of reasons and decisions, real durations, real token counts and real usage-limit readings are unseen. No capture has a usage reading, so the allowance path from a real Claude or Codex reading is unproven; the window names (`five_hour`, `seven_day`, `seven_day_<x>`, `<n>_minutes`) come from the runners' parsers. What Codex reports on the planned plan (possibly no 5-hour window) is unknown.
- **A run's whole life with a real lock.** The captured mid-run states have no `mc.lock` or `dispatch.json`; tests synthesise them from the shapes in the code. The integrator of the first build did check, against the real engine and with scripted AIs only, the real lock heartbeat and a run killed with SIGKILL. A Docker stop, an out-of-memory kill and a run of hours were not observed.
- **The asleep and finalize rules (4.2).** That the saved status stays `waiting` while the agent runs after a wait, and that `done` or `partial` is saved before the report is written, is read from the code (`src/dispatcher.ts:752-757`, `src/executor.ts:156-176`, `src/dispatcher.ts:1955-1967`) and from the order of events in `raw/d2-limit-then-done/events.jsonl`. The integrator of the first build verified both rules against the real engine, with scripted AIs only. Nothing was seen with real AI output, with a wait of real length, or with real limit readings.
- **The pacing display (10.7).** That a reading at or above its cap blocks the provider is read from `src/quota.ts:358-369` and from driving the real governor on synthetic readings, not from a real reading. The share of the week one run may use cannot be seen at all.
- **A login wait (4.6).** That a wait whose reason has a login part is a sleep for the other provider's limit is read from `src/executor.ts:243-257` and `src/quota.ts:225`; no capture has one.
- **`--until` against the engine's real deadline.** The dashboard recomputes it with `parseUntil` from the lock's `at`; that equals the engine's value only when the same `HH:MM` is given. The reason the engine writes when the stop time comes (`stop requested`, the same as for a STOP file, 4.5) was seen with a scripted AI and a moved clock, not on a real machine with real signals.
- **Time zone in the container.** `mc-docker.sh` passes `TZ`; that the Node in the image formats times in it was not run (it was checked locally with `Intl`, Node 22.22).
- **Behaviour on a Windows-mounted folder.** Atomic rename on such a folder is unverified in the assessment; the dashboard assumes the home is on the Docker volume.
- **Line numbers** are from commit `8342744`.

### 20.2 Decisions the build agents implement as written, and the owner should confirm

The owner accepted every default below, except the 18 hour window of item 1, which became 24 hours (item 1 now says so).

The brief says to implement report section 4 as written. These are the decisions where this spec does something else, or reads the report one of two ways. Each is a small rule that can be reversed; 5.6 says how.

1. **Recent means the last 24 hours, or being worked on now.** The owner's team works on whatever it is asked, for as long as that takes (two hours or two days), so no rule is tied to a time of day (the report said: since the live run's lock `at`; the first version of this spec said 18 hours, the engine's longest stop time, and the owner replaced it with 24). A mission that a live run works on is recent whatever its age; an unreadable mission is always recent. Reason: a restart in the middle of a run, and a long task that is still being worked on.
2. **An earlier failed mission is amber; an earlier finished mission's leftovers never change the lamp** (report: "capped at amber" for all older items). Reason: the engine never clears a decision on a finished mission, so the lamp would be amber for ever.
3. **A queued mission is grey, not amber.** Reason: it has no features yet and only waits for the next run.
4. **A requested stop is amber** (not in the report).
5. **The Final review passed tick keeps its state and gets a caveat** (report: withheld with a caveat).
6. **A wait of unknown cause or with a login problem is amber at any length** (report: amber only over 60 minutes); a short wait of a known cause is green.
7. **The first minute after a run disappears is amber** (calm grey in the first version of this spec).
8. **The mission word is "Waiting"** for any cause (report table: "Waiting for allowance"; the report's own design decision says to use a neutral label in Phase 1).
9. **The debrief tick keeps its name "Final review passed"** while the progress step is "Final check", because the brief fixes both names. The glossary (4.0) separates "final check" (the step), "final tests" and "final review".
10. **The four quick phrases are offered everywhere** (as the brief decided); the sheet says what the leader cannot do instead of hiding phrases.
11. **Two missions or features with the same title are told apart by their id** in the pasted sentence, because `mc status` shows ids and no start times.
12. **An unreadable `mission.json` keeps the lamp amber whatever its age**, because unknown data is never green; a folder with no `mission.json` is ignored.

---

## 21. Amendments made at integration

The build agents found places where this spec could not be followed as written or said nothing. The integrator amended the text above where a rule changed (2.2, 2.3, 2.5, 4.2, 4.6, 5.3, 7.1, 7.2, 10.9, 14.2) and lists every reading here. Each one is implemented and tested. Nothing in the engine changed. Rows 23 and later were made after four adversarial reviews of the finished build. Rows 43 and later were made after the independent verification and the owner's decisions of the next round.

| # | Where | What the build does | Why |
|---|---|---|---|
| 1 | 2.2 `buildNow`, `buildMissions`, `MissionFacts` | `buildNow` takes the clock as a fourth argument; `MissionFacts.runGone` is `"pending" \| "gone" \| null`; `buildMissions` and `buildNow` take `RunFacts = Pick<RunInfo, "active" \| "startedAt" \| "heartbeat">`. | The "9 min so far" text and the L2/L3 grace need a clock. RunInfo's line, activity and deadline are built from the missions, so a full RunInfo cannot be an input. |
| 2 | 2.2 other additions | `HomeData.skippedFolders`, `SnapshotOptions.onError`, `homeStatus()` (for `/healthz`), `clearReadCache()`, and the helpers `scopeMissions`, `workedMission`, `missionActivityAt`, `readLabel`, `isSavedBusy`, `attachCardIds` are exported. | Additive. `skippedFolders` makes `olderMissionsHidden` count folders beyond `MAX_MISSION_FOLDERS`. |
| 3 | 3.2 cache key | The key is path, size, mtime and inode; file times are rounded to whole milliseconds. | An atomic rewrite keeps the size and can keep the mtime inside one clock tick. A time with a fraction made `heartbeatAgeMs` 119999.0009765625. |
| 4 | 1.4, 4.2 `staleBusy` | An open `run.start` older than the live lock's `at` does not count as open. | A killed run leaves an open `run.start`; without this the rule could never hold for the leftover it is written for. |
| 5 | 13 E5 | An unknown stage also gives state `unknown`, except for a `failed` mission, which stays "Needs you". | The 4.2 table only looked at the status; a red card must not turn amber because a stage has a new name. |
| 6 | 5.3 L6 | L6 looks at readable missions only. | An unreadable mission is already counted by L5 (one fact, one reason). |
| 7 | 5.2, 10.10 | A wait and the allowance banner both use mission state `waiting`; a dead run with a saved `waiting` mission is Paused (unexpected) and has no banner. | The two sections used different words for the same fact. |
| 8 | 4.6 `partly_done` | Two short sentences: "1 feature is stuck. 1 feature was left out." | The joining was not specified. (The debrief verdict of 11 still drops the left-out part when something is stuck.) |
| 9 | 7.1 row 9, 7.2 rule 3 | `N` in "(step k of N)" is `steps.total` of the feature's view; items merge only when `text`, `tone` and `note` are equal. | `buildTimeline` has no settings; two failures can read the same and carry different AI notes. |
| 10 | 4.6, 4.5, 9.2, 9.3 | The wait text parser and the reason and stop tables live in `vocabulary-details.ts` (re-exported by `vocabulary.ts`). A wait reason is read part by part, not split on "; ". | The timeline, the banner and the mission view all need them. The failure text inside "keeps failing (...)" may contain "; ". |
| 11 | 10.9 | The note is "No 5-hour limit reported." with a period. `types.ts` says the same. | A model-block sentence is appended with a space. |
| 12 | 14.2 | `quota-nearly-out/` has `seven_day` 0.80, not 0.86. | 0.86 is past the 0.85 weekly pause cap, so the pill would read `waiting_reset`. `quota-paced/` covers the paced cases. |
| 13 | 11 | The overall verdict sentence lists done, partly done, paused, then "N need(s) your help". The Final review passed caveat "It covered only the d features that were built." needs `d > 0`. The Recovered list's `note` is the feature's story. | The order was not given; a caveat must never say "only the 0 features". |
| 14 | 12 / types.ts `NowLine.featureId` | `featureId` is also filled for kind `between_steps` (the feature in progress). | The text names that feature. |
| 15 | 2.3 | Routes match the raw request target; a target that does not start with `/` is 400; `CONNECT` is 405; a refused request is sent with `Connection: close` so its body is never read. | `new URL` turns `//x` into `/` and would serve the page, which E36 forbids. |
| 16 | 2.5 | `--until` is validated in `runDashboard`; the printed address says `localhost` for a wildcard or loopback host. `command.ts` exports `parsePort` (the CLI action uses it), `server.ts` exports `atMostOncePerMinute`, and `page.ts` exports `PAGE_FILE` and a `loadPage(root)` whose root defaults to the package root. | Same behaviour and exit code; the commander action stays a few lines. |
| 17 | 2.6 | `mc-docker.sh dashboard` validates its arguments (port 1 to 65535, `HH:MM`, unknown option, missing value) and, when a dashboard already runs, says `http://localhost:8787 unless you chose another port`. | The script cannot know the earlier port without querying Docker. |
| 18 | 14, T-FIXTURE, 14.4 | `quota-corrupt/` and `unreadable-mission/` are invalid JSON on purpose (the test names exactly those two files). The test looks for `/capture/` and `capture/home` rather than the word, because one fixture has a feature called "capture". | The spec's rules contradicted two fixtures. |
| 19 | 17, 17.1 (page) | The page takes the SVG namespace from its own inline sprite, so the file holds no `http://`. A Needs-you card header is an icon by kind, the snapshot's `title` and the mission name (no kind word). Tiles of features that are waiting their turn or left out with no steps used show no "Reinforcements called in" block. The stop sheet hides the quick phrases and the own-words box (`stopSentence` has no placeholder) and shows `stopNote`. "Updated" reads "N min ago" from 60 s. The global bar is sticky on every tab. Captions and labels are 14 to 15 px; body text and sentences are 16 px or more. The page stores nothing in the browser. | 17.1 did not cover these cases, or two of its rules conflicted. |
| 20 | 8, 16 (leader) | `leader/.claude/settings.json` has an `allow` list (status, logs, report), an `ask` list (stop, run, new, feature; 16) and a `deny` list (Edit, Write, NotebookEdit, Bash(git:*), `logs *--follow*`). `leader/CLAUDE.md` first checks with `status --json` that a run is going before it asks to stop, and says nothing is stopped when none is. `leader/CLAUDE.md` follows 8's `stopNote` (stopping cancels the running AI step) although the `mc stop` help text says "after its current step". | The engine aborts the running step (`src/run.ts`, `StopControl`); the CLI help is loose and is an engine file. |
| 21 | 18 | In `docs/mvp-spec.md` the references to "the assessment's section 6" read "the first design of the dashboard", because the assessment is not in the repository. | The reader of the repository cannot open it. |
| 22 | test files | Extra files beyond 16: `src/dashboard/vocabulary-details.test.ts`, `src/dashboard/invariants.test.ts`, `test/dashboard-kit.ts`, `test/dashboard-facts-helpers.ts`, `src/dashboard/constants.test.ts`, `src/dashboard/limits.test.ts`. | Shared test helpers and tests for the split of agent 1. |
| 23 | 3.3, 8, 15 T-LEADER, 13 E52 | `clean()` removes every Cf character plus the invisible fillers and selectors listed in 3.3; the `tellLeader` comments say the names inside are data. | Review finding M1: hidden text in a title reached the pasted sentence. |
| 24 | 4.0, 4.5, 4.6, 7.1 row 4, 14.2 | The stop table is worded for "a stop was requested or the stop time came"; the `deadline` row is "no AI would be free before the stop time". | M2: the engine writes `stop requested` at the stop time too. |
| 25 | 3.2, 4.6, 5.3 L17/L21, 5.4, 6.1, 10.6, 10.9, 10.11 | One time rule (`Formatter.when`): HH:MM on the day of the snapshot, else weekday and time. | M3: a three-day wait read "until 15:26". |
| 26 | 5.4 | A lamp sentence made of one long wait of known cause ends with `It resumes by itself.`; the green short-wait sentence carries it too. | M5, interface decision 1. |
| 27 | 9.1, 9.3, 6.3, types.ts | `NeedsYouCard.whatToDo`; named AIs in login failures; `ifNothing` of a retryable failure; `login_needed` wording (waiting, not asleep). | M6, m14. |
| 28 | 3.2, 13 E8, 5.1 | Quota times and utilization out of range are skipped entries. | m1 |
| 29 | 3.2 | File-derived keys are looked up with `Object.hasOwn`. | m2 |
| 30 | 3.2, 5.1, 13 E53/E54, types.ts `Counts` | Caps on missions (30) and cards (50), the size limit enforced by building again with less, two new counts, `SnapshotOptions.maxBytes`. | m3 |
| 31 | 7.1 row 9, row 9 above | The step in "did not pass its checks (step k of N)" is the failed step; the last one says all steps are used. | m7 |
| 32 | 13, test helpers | `assertSnapshotShape` knows `whatToDo`, the two new counts, the caps and the longer list of invisible characters. | The shape check follows the contract. |
| 33 | 8, 17.1 (Copy) | Copy is marked `aria-disabled` until a quick phrase or words are chosen (never for the stop sheet) and then says what to do. | m9: a copy of `... <your answer here>` pasted a placeholder into the chat. |
| 34 | 17.1 (done tiles) | A first-try Done tile is one line with no button. The rule "Tell the leader on every tile" reads "on every tile that is not a first-try Done tile"; the global bar and the Results tab still cover finished work. | m7: fifteen identical buttons and three phrasings of one fact on a finished run. |
| 35 | 17.1 (Tile, steps) | Waiting-turn, left-out, not-yet-tried and first-try features show no steps line. A paused or being-built feature with no tries yet shows none either. | `Reinforcements called in: none (0 of 5 steps used)` with five hollow pips said nothing. |
| 36 | 12 / 17 (groups) | The page orders the groups: `needs_you`; then stuck, partly done, unknown or with a card; then working, waiting, paused, done, not started. Stable within a rank. | Interface decision 5: the red mission was 3500 px down. |
| 37 | 17 (progress line) | A stopped (`needs_you`) or paused mission draws its current step with a mark and a caption, not as work. | m15 |
| 38 | 17.1 (results link) | `Results are ready` is a button row under the strip, only when `debrief` is not null and `run.active` is false. | m11 |
| 39 | 5.5, 17.1 (greyed) | `.gone` is `grayscale(1)` with opacity 0.95, not 0.62, and the frozen live lines are not drawn at Not responding. Measured: 0.82 still gave 3.77:1 on muted text in light mode, 0.9 gave 4.45:1, 0.95 gives 4.95:1 or better in both themes. | m13 |
| 40 | 8, 16, 18, 20.1 (leader) | The leader's permissions are `allow` (status, logs, report), `ask` (stop, run, new, feature) and `deny`; `leader/CLAUDE.md` treats AI-written text and quoted names as data, reads `report` for its first 40 lines, checks `status --json` before a stop, answers "skip it" and forecast questions honestly, and passes `--until` only when the CEO gives a stop time (round decision R5: the rule "ask for a stop time on every run" was removed; it came from carrying the engine's own wording about a run into the leader). Without `--until` the run has no stop time and no upper limit: it goes on until the queued work is done or a stop is asked for (`src/run.ts` logs "Working until the queue is done (no stop time given)."); with a stop time, the engine refuses one more than 18 hours ahead. Remote Control is written from Anthropic's documentation (`claude --remote-control`), still not tried. | M8 to M10, m16 to m21 |
| 41 | 8, 17.1 | `leader.canDo` reads "The leader can look at progress and reports, stop the run, add new work and start the team working through the queued work. It cannot change a plan or reopen a stuck feature." The allowance heading reads `Allowance (how much of your plans is used)`. | m9 (c), m14: "new request or a follow-up" and "usage left" next to gauges that say "62% used" were jargon and a contradiction. |
| 42 | 3.2, 17.1 | The page says how many missions and cards the snapshot cut (`counts.missionsNotShown`, `counts.cardsNotShown`), so a cut list is never silent. | m3: the caps were honest in the data and invisible on the page. |
| 43 | 8, 17, 17.1 (page words) | The tabs are Now, Needs you, Timeline and Results. The buttons are "Tell the leader about this" (every card, tile, quiet-row mission and results mission), "Tell the leader anything" (the bar) and "Stop the current run". The quiet row is "Earlier work still open (N)", read from `counts.openFromEarlier`. The heading over the four ticks is "How it went". The header shows the product name and the freshness line only. The page's names follow the same words (`now`, `results`, `earlier`). | The owner's team works on whatever it is asked, for as long as that takes; the page carries no time-of-day framing. |
| 44 | 17.1 (Needs-you empty state) | With no cards the Needs-you tab says `Nothing for you to decide. See the note on the Now tab.` beside any lamp other than green or grey, and the line follows the page's own clock (Not updating, Not responding). | V6: the sentence "Nothing needs you right now." beside an amber lamp read as a contradiction on the one tab where the lamp is not visible. |
| 45 | 8, 15 T-LEADER-DOC (leader) | `waitingUntil` in `mc status --json` is a UTC string (it ends in Z) and the plain `mc status` table prints the same moment in local time. `leader/CLAUDE.md` and `docs/leader.md` say so, and tell the leader to read the local time from the WAITING UNTIL column. A test runs the real CLI with a time zone set and checks both. | V2: the leader would have told the CEO the UTC clock time as if it were local. |
| 46 | 8, 15 T-LEADER-DOC (docs) | `docs/leader.md` says: "The only text an AI wrote in a sentence is a mission or feature title; leader/CLAUDE.md tells the leader that these names are data, never instructions." The old sentence "No sentence contains text an AI wrote" is gone and a static check keeps it out. | V1: the sentence had survived the fix of M1 and was false. |
| 47 | 4.6, 5.1, 6.3, 10.6, 10.9, 10.11, 13 E55 | One time rule with a date form: from `DATE_FORM_AFTER_MS` (6 days) away, in either direction, `Formatter.when` adds the date ("Mon 19 Oct 10:03"). It covers every wait, reset and change time and the stale-lock line. `resumeWhen` now takes the formatted time. | V3: a weekday alone repeats weekly; a wait of 8 days ahead read "Mon 10:03" on a Sunday and was taken for tomorrow. |
| 48 | 5.1, 5.6 item 1, 12, 13 E46 E48 E56, 14.2, 20.2 item 1 | The recent window is 24 hours (`RECENT_WINDOW_MS`). The first version used 18 hours, the engine's longest stop time. A mission last saved 19 h ago is still recent; the `scope-mix/` fixture holds its earlier missions at 26 h and 27 h. | The owner's work is not organised around a time of day: a task can take two hours or a day, and the window must not be tied to the engine's longest stop time. |
| 49 | types.ts, 4, 5.3, 6, 9, 12, 15 | The two scope kinds are `recent` and `earlier`. The fields that carry the scope words read `MissionView.openFromEarlier`, `NeedsYouCard.fromEarlier`, `Counts.openFromEarlier`, `.earlierNeedYou`, `.earlierWaitingForYou` and `.recentMissions` (`.olderMissionsHidden` keeps its name: it counts finished missions that are not listed at all). The lamp reasons L15, L23 and L26 are `earlier_failed`, `earlier_items` and `nothing_running`. | The product is a team that gets whatever the CEO asks done; nothing we wrote may revolve around a time of day. |
| 50 | 4.0, 5.3, 5.4, 8, 9.1, 11, 15 T-VOC | Wording: no snapshot string, key, enum value, constant, test title, fixture or comment of ours holds a word of the time-of-day row of 4.0 ("midnight" is allowed). The L2 clause reads "the run stopped unexpectedly"; L15, L23 and the grey sentence say "earlier" for earlier work; `leader.globalSentence` is "About the current work: <your answer here>", `leader.stopSentence` is "Please stop the current run.", `leader.canDo` says "add new work and start the team working through the queued work"; the cards of a failed mission and of a run that died say "start the team working again"; the verdict sentence of several missions is `overallSentence`; `vocabulary-details.ts` holds the wait text, timeline, allowance and debrief words, and `test/dashboard-facts-helpers.ts` the hand-made mission facts; the T-VOC scan fails on a time-of-day word in an engine-written string, a JSON key or an enum value. | Same reason as row 49. The engine's own messages (a notification title, the README tagline) still use that framing; they are not ours to change. |
| 51 | 17.1 (Now, repeats; Empty states) | `No missions yet. When one is queued it appears here.` shows only when `missions[]` is empty. With only earlier missions the Now tab shows no such line and no features heading, only the lamp, the strip, the quiet row and the allowance. | Found in the browser proof of this round: with the 24 hour window an earlier failed mission and nothing recent is an ordinary case, and the line "No missions yet" sat directly above the earlier mission it denied. |
| 52 | 3.2, 4.2, 4.5, 4.6, 5.3, 7.1, 8, 9.1, 11, 12.2, 14.2, 17.1 | The human checkpoints (docs/checkpoints-spec.md, lean first version). A mission saved as `stopped` with a `checkpoint` is `paused` with `pausedWhy` `checkpoint` (no new state id). It has one amber `checkpoint` card (second in `CARD_KINDS`, with `lines` and `answers` on this kind only), one amber lamp reason `checkpoint_waiting` (L10a, in the rest-is-on-track set; an answered check raises nothing), the sentences of 4.6, and six timeline types (27 to 32; `checkpoint.passed` hidden). The card's two buttons copy two sentences; the approval has no placeholder, so the sheet hides the answers it does not need and Copy works at once. `leader.canDo` and the leader's command set grow by approve and send-back. Two decisions made here, not in the checkpoints spec: (a) a `pending` checkpoint keeps its mission `recent` however old, because a check can wait for days and its card and lamp reason must not age out (12.2); (b) a mission that waits for a check is left out of the results (11), because "continues on the next run" is not true of it. | The checkpoints spec's section 10 sized the change from the code and left both questions open. (a) follows from "one card per mission with a pending checkpoint" and from the lamp being amber until the owner answers. (b) avoids a Results entry that contradicts the card. |
| 53 | 3.2, 8, 9.1, 15 T-LEADER-DOC, 16 | Leader-written plans (docs/plans-spec.md). `read.ts` keeps `plan` of a mission as a blank flag. The plan-stop card of a mission with that flag has its own `happened` and `summary` (the first says the leader wrote the plan and the owner looks at it first; the second says to ask the leader for every check word for word, and that the owner can print all of it at the PC), because such a plan stops by default and the card holds 12 lines. A feature or final check of the same mission keeps the old texts. The leader's command set grows by `plan preview`, `plan queue` and `plan show`: the first and last only read and are in `allow`, `plan queue` is in `ask`. | The plan stop is not one the owner asked for, and the 12-line card cannot carry a plan; the whole text is one command away (`mc plan show`). The `allow` entries rest on a spike with limits (docs/leader.md): a mismatch only makes Claude Code ask. |
| 54 | 3.2, 4, 7, 9, 11 (work modes, Step 3) | Features checked by a second AI (docs/modes-spec.md, 11). `read.ts` keeps `mode`, `effort` and `ownerStops: false`, and of `checked` only the number not judged, whether the review did not finish and the code of each result (no check text, no evidence); the three new event types keep whole numbers and two short codes. A mission with no such feature is shown exactly as before (`test/dashboard-compat.test.ts` pins every older fixture by hash). See section 22. | The Results page and the card must not say "tests" or "built and checked" for work that no test checked, and must say what the checkpoint log holds ("approved by you"), never that the owner looked. |

## 22. Work modes (Step 3)

The design is in [docs/modes-spec.md](modes-spec.md), section 11, and the owner's guide is [docs/work-modes.md](work-modes.md). The dashboard stays read-only, takes no new data source and shows no picture. Every change below happens only for a mission that has at least one feature with a `mode` ("review" or "owner"); every other mission renders byte for byte as before.

**What it reads.** `mode`, `effort` and `ownerStops: false`; of a feature's `checked` record only `unjudged`, `unfinished`, the result code of each check (the list is kept as placeholders with no text, so a count of unmet checks can be said) and the code `pictures.why` (only whether a page was expected and the second AI was shown no picture of it); of a feature checked by a second AI also the number of its checks (one empty placeholder for each of its `acceptance` lines, for the tile); of a repair feature `changesApproved` (the ids of the approved work it changed); nothing of `expect`, the check texts, the evidence or the pictures. A `mode` or `effort` that is not one of the known words makes the whole mission file unreadable, as it does for the engine (`MissionStore.load`), so the page never shows such a feature as one checked by tests. From the three new events (`deliverable.checked`, `pictures.taken`, `rubric.checked`) it keeps whole numbers and the short codes `why` and `projectChecks`, and nothing else.

**What it says.**

| Where | Words for a mission with a feature checked by a second AI |
|---|---|
| Results, each finished feature (`checkedBy`) | `Checked by tests`, `Checked by tests; approved by you`, `Checked by the project's own checks only; no tests were written`, `Checked by Mission Control's own checks only; the second AI's check did not finish`, `Checked by a second AI against your list; 2 checks were not met`, `... ; 1 check was not judged`, `Checked by a second AI against your list`, each with an ending `; approved by you` or `; queued without a stop for your look` (and, when the second AI was shown no picture of a page, `; queued without a stop for your look; no picture was shown to the second AI`) |
| Results, verdict | `All 3 features are built. The list below says how each was checked.` |
| Results, Delivered | `All 3 features were built. How they were checked: 1 by tests, 1 by a second AI against your list, 1 by a second AI and approved by you.` |
| Results, Final review passed (caveat) | adds `2 features have no tests. The list below says how each was checked.` |
| Results, note at the bottom | when the log holds the owner's approval: `These are the AI team's own checks. You were asked to look at “A” and approved it.` |
| Mission sentence | `All 3 features are built.` |
| Owner stop card (`happened`) | six reasons: marked for the owner's look, checks the second AI could not judge, the second AI's check did not finish, sent back and shown again, the second AI was shown no picture of the page, and the final repair changes work the owner approved; a stop asked for with `--checkpoint feature` keeps the old words (the repair's reason is said even then) |
| Timeline | `A second AI checked “X” against your list: 3 of 4 checks passed. 1 needs a fix.`; `Mission Control's own checks of “X” found problems. The AI is asked to fix them.`; the pictures rows; a merged feature reads `“X” is added.`; and, when no finished feature is checked by tests, the final steps read `The final checks of the whole app passed.` |
| Feature ladder | a feature checked by a second AI has no diagnosis step, so its ladder is one step shorter |

The two engine sentences that the page had to learn are the stuck reason `tried every escalation step, but Mission Control's own checks still failed: ...` (the part after the colon is never shown) and the note `The review of “X” did not finish, so it was merged after passing Mission Control's own checks only.`, which the Final review passed caveat counts like the older note.

**Tests.** `src/dashboard/modes.test.ts`, `src/dashboard/modes-snapshot.test.ts`, the added random homes of `src/dashboard/invariants.test.ts`, `test/dashboard-compat.test.ts`, and the three synthetic fixtures `modes-review-round`, `modes-owner-stop` and `modes-mixed-done` (marked synthetic in `PROVENANCE.json`; hand-written to the types, not captured from the engine). `test/modes-dashboard.test.ts` replaces trust in those fixtures: it queues examples A and B of the design through `mc plan queue -`, lets the mock team run them (a real guide and a real page, so Mission Control's own checks run for real), and checks the Results sentence, the tag of each feature, the timeline and the card against what the engine wrote. `test/modes-wording.test.ts` applies the wording rule to every surface of such a mission.

**Not verified.** The wording of the owner-visible lines was scanned by hand and by the test of the rule in docs/modes-spec.md 10.3, not by a person on a screen. No mission run by a real AI with a feature checked by a second AI has been shown on the page; the missions of `test/modes-dashboard.test.ts` were run by stand-in AIs.
