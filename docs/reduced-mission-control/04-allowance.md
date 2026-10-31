# P5 — Unknown allowance and launch admission

Part of the [build specification](../reduced-mission-control-spec.md).

**Current local reconstruction, 31 October 2026:** the reviewed cloud delivery is unavailable. Follow [10 reconstruction plan](10-reconstruction-plan.md), [11 regression supplement](11-reconstruction-regressions.md) and the newest HANDOFF entries. Original requirements below remain binding. No reconstructed behavior is validated. All test/typecheck/build/OS execution and active runtime integration remain held until explicit owner clarification; command lists and older permissions below do not override that hold.

## Outcome

The system distinguishes “allowed by known readings” from “we cannot tell.” Strict mode stops before a model job when required allowance evidence is unusable. Existing settings retain their behavior with explicit warnings.

**Estimate:** 8–16 hours, low–medium confidence. **Dependencies:** P0, P2 launch context, shared contracts. Serialize executor/run-loop edits with P1.

## Files

Existing: `src/quota.ts`, `src/executor.ts`, `src/run.ts`, `src/dispatcher.ts`, `src/runners/codex.ts`, `src/runners/codex-app-server.ts`, `src/runners/claude.ts`, `src/types.ts`, `src/config.ts`, `src/state.ts`, reporting and dashboard allowance readers.

Proposed pure policy module: `src/allowance.ts`. Keep provider transport in the existing runners; do not build a new account service.

Tests: `src/quota.test.ts`, `src/executor.test.ts`, `src/run.test.ts`, `src/dispatcher-safety.test.ts`, both runner test files, `src/config.test.ts`, `src/dashboard/allowance.test.ts`, `test/outages.test.ts`.

## Policy contract

Proposed setting:

```yaml
pacing:
  unknownAllowance: stop
```

Only `stop` and `warn` are accepted.

- Omitted in an existing configuration: `warn`, preserving its previous admission behavior.
- Newly generated setup configuration and the reduced example: explicitly write `stop`.
- The loader must preserve the distinction between absence and an explicitly chosen policy. An invalid value is an error.
- Do not change an existing on-disk config automatically.
- No bypass flag or automatic downgrade is added. The owner may later deliberately change the setting; that is not a reason to launch anything during this implementation.

The selected policy is fixed for one coordinator invocation and recorded in its summary. A later deliberate config change applies on the next invocation. This differs from P4's per-mission helper snapshot: safety policy must not be silently pinned forever by an old mission.

### Usable observations

- [ ] **U01:** Record controller receipt time for each observation, not an AI-supplied claim about freshness. Persist this time with the observation.
- [ ] **U02:** The required aggregate windows are `five_hour` and `seven_day`. Model-specific windows remain additional constraints; they do not substitute for the aggregate windows.
- [ ] **U03:** An observation is usable when utilization is finite and nonnegative, its reset is in the future and within the existing plausible reset bound, and its receipt is no more than **10 minutes** old. This initial conservative age is a documented constant, not another public tuning knob.
- [ ] **U04:** A receipt in the future is unusable after a clock rollback; legacy persisted readings without receipt time are unknown for strict admission. Restoring a file does not refresh its timestamp.
- [ ] **U05:** A new valid reading that omits its reset may inherit a still-valid reset for that same provider/window. A supplied malformed/implausible reset does not gain credibility merely by replacing it with an older one. An expired reset cannot be inherited.
- [ ] **U06:** Repeated identical readings refresh the receipt time. Current value-equality shortcuts must not leave a newly observed reading looking stale.
- [ ] **U07:** Missing, stale, malformed and reset-less observations remain distinguishable reasons. Unknown is never displayed as zero usage or a free allowance.
- [ ] **U08:** Known hard limits, throttles, login failures and provider failures retain their existing treatment. Reaching a reset removes that old block but does not invent a new fresh utilization reading.

## Admission before any model job

The current Codex account query occurs inside its runner's first job. Strict admission requires a separate metadata-only preparation path so it does not block forever before the path that could obtain a reading.

- [ ] **U09:** Add an optional runner metadata method (`AgentRunner.readAllowance`) that obtains allowance observations without invoking a model. The Codex implementation reuses its existing local app-server account/rate-limit path and billing checks. Preserve/carry its result into the runner so it need not duplicate the first query.
- [ ] **U10:** Claude has no new preflight mechanism in this scope. Its existing streamed observations remain usable; otherwise strict admission reports unknown. Do not scrape undocumented account endpoints, read another application's session or make a paid model call to bootstrap.
- [ ] **U11:** Query metadata only when needed for missing/stale data, bounded by its existing timeout and abort signal. At most one attempted refresh per candidate provider in one job's admission decision. Unknown data is not an invitation to poll forever. Recheck stop/deadline after metadata work.
- [ ] **U12:** In `stop` mode, start a candidate only when its required observations are usable and existing quota rules allow it. A different eligible family may run under existing failover rules; P1 records what actually ran.
- [ ] **U13:** If no required candidate can start because allowance is unknown, end that mission's current attempt cleanly with a dedicated allowance pause reason, unchanged work stage and a clear message. Do not mark the feature failed, infer a reset time, approve anything or automatically retry it in a tight loop.
- [ ] **U14:** Use an additive `Mission.pause` record with kind `allowance_unknown`, affected providers, reason and time. The run summary distinguishes it from an owner checkpoint. A deliberate later run can retry after obtaining usable data; clear only this pause when the condition is resolved. Do not alter an existing pending approval.
- [ ] **U15:** If another known candidate is merely limited until a real reset, existing bounded waiting may still be used. Reassess freshness at wake-up. Stop and deadline always take precedence.
- [ ] **U16:** Optional helpers with no eligible candidate skip without pausing required work. Their absence must not create evidence or a usage charge.
- [ ] **U17:** In `warn` mode, retain current launch behavior and limit handling, but show “allowance could not be confirmed; the reserve is not assured.” Do not render a green assurance of available allowance from provider status alone.
- [ ] **U18:** Metadata-only work never increments the model-attempt count or invents token/cost usage.

## Retry cap and persistence

- [ ] **U19:** Reserve one mission attempt slot before every worker-runner invocation, including internal executor retries. Count attempted launches conservatively; an invocation that fails to start can still consume a slot. Metadata-only requests do not.
- [ ] **U20:** Remove the later double count for the same attempt. Use a controller-owned callback or equivalent single-writer reservation so executor retries and dispatcher saves cannot overwrite each other's counts. Persist before launch; a restart must not lose a consumed reservation.
- [ ] **U21:** The configured attempt cap prevents the next invocation once reached. Optional work skips at the cap; required work follows the existing explicit cap-stop outcome. Do not solve this by reducing the configured cap or hiding retries in usage totals.
- [ ] **U22:** Preserve existing observed per-run weekly-share semantics. A new invocation currently starts a new per-run share baseline; document this. Do not describe it as an account-wide or restart-proof reservation. Broader durable budget accounting is outside this package.

## Owner-facing behavior

Examples:

- Strict: “Stopped before starting another AI job: Claude's allowance could not be confirmed. No model call was made for this attempt.”
- Warning mode: “Allowance readings are incomplete. Existing usage limits still apply, but Mission Control cannot assure the reserve.”
- Stale: show when the last observation was received, without claiming it is current.

The CLI, report and dashboard must agree on policy and uncertainty. No new remote approval/control surface.

## Acceptance matrix

| Case | Expected result |
|---|---|
| Strict, no readings and no metadata route | Zero model calls; explicit pause |
| Codex metadata supplies both valid windows | Admission can proceed if all other gates allow |
| Metadata times out or returns malformed data | Zero model calls for that strict candidate |
| Claude cold start in strict mode | Honest pause; no paid probe |
| One required window missing | Unknown, not partial assurance |
| Fresh reading inherits valid same-window reset | Usable |
| Expired, implausible or supplied malformed reset | Unknown; no guessed permission to start |
| Identical new reading | Freshness advances |
| Saved reading restored | Original receipt preserved |
| Time advances beyond 10 minutes or clock rolls backward | Strict candidate is not admitted from that reading |
| Failover candidate has valid low usage | Can run; actual identity recorded |
| All providers unknown | One clear pause, no retry spin |
| Optional helper unknown | Skipped; required work assessed separately |
| Warning mode with unknown reading | Existing behavior plus visible uncertainty |
| Internal retries reach attempt cap | Next worker invocation never starts |
| Restart after reserved attempt | Reservation retained; no double count |
| Stop/deadline during metadata wait | No subsequent model launch |
| Outside-account consumption raises observed use | Updated observation constrains the next job; no claim of exact reservation |

## Evidence limit

Use fake clocks, fake metadata and stand-in runners only. Real account reads, subscription-limit behavior and provider compatibility remain untried. A strict mode that correctly refuses to start with missing data is a valid test outcome; it is not proof of an operational real-provider workflow.
