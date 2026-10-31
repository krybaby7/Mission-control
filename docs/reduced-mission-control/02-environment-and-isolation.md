# P2/P3 — Worker environment and Linux isolation

Part of the [build specification](../reduced-mission-control-spec.md).

**Current local reconstruction, 31 October 2026:** the reviewed cloud delivery is unavailable. Follow [10 reconstruction plan](10-reconstruction-plan.md), [11 regression supplement](11-reconstruction-regressions.md) and the newest HANDOFF entries. Original requirements below remain binding. No reconstructed behavior is validated. All test/typecheck/build/OS execution and active runtime integration remain held until explicit owner clarification; command lists and older permissions below do not override that hold.

P2 must be reconstructed against the local launch sites. Partial cloud P3 results are historical reports with unavailable raw evidence; no surviving fixture or demonstrated WSL boundary is assumed. Re-author missing fixtures and keep P3/P3b conditional.

## Outcome and separate gates

P2 reduces what worker processes inherit. P3 proves an operating-system boundary with harmless fixtures. P3b integrates only a demonstrated mechanism. An environment filter alone is not file isolation.

| Package | Estimate | Stop condition |
|---|---|---|
| P2 environment | 4–8 hours, medium confidence | Focused tests and subprocess inventory complete |
| P3 experiment | 4–8 active hours maximum, low–medium confidence | Written pass/blocker result; no automatic extension |
| P3b integration | Provisionally 1–3 days, low confidence | Requires P3 result and reviewed concrete integration design |

No Docker, product login or real provider call is permitted in these packages. No sudo installation without the owner's approval.

## P2 files and contract

Existing call sites to inspect: `src/util/process.ts`, `src/runners/claude.ts`, `src/runners/codex.ts`, `src/runners/codex-app-server.ts`, `src/runners/worktree-guard.ts`, `src/verify.ts`, `src/render.ts`, `src/git.ts`, `src/dispatcher.ts`, `src/doctor.ts`, and child-process use in `src/cli.ts`.

Proposed module: `src/util/child-env.ts`. It builds a fresh environment from an explicit launch context; it must not begin by copying `process.env`.

The caller identifies the launch purpose: worker, verification, rendering, provider metadata or controller Git/diagnostic command. Do not change the owner's shell environment or developer GitHub login.

- [ ] **E01:** Start with an empty object. Add only documented names from trusted controller inputs. Unknown variables are absent.
- [ ] **E02:** Baseline permitted data: native Linux `PATH`, the intended `HOME`, a controlled temporary directory, and explicitly needed locale/time-zone/color values. Validate path inputs; do not pass inherited Windows search paths.
- [ ] **E03:** Provider-specific config-home locations may be supplied explicitly for the selected provider. Do not automatically forward another provider's config, the whole host home or arbitrary process variables. P3 decides the enforceable file view.
- [ ] **E04:** Do not forward API/billing routes, GitHub tokens, SSH-agent sockets, arbitrary `GIT_*` variables, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, loader injection variables or arbitrary language search paths. Fake values in tests must be harmless and confined to test objects/child contexts.
- [ ] **E05:** Git control values required by the controller are constructed explicitly at their protected call sites. They cannot be supplied by a worker's project or inherited environment.
- [ ] **E06:** Proxies and custom certificate/config locations are not a generic bypass. If compatibility needs one, document the exact purpose, validate its value/path, and add a narrow explicit policy. Never silently fall back to inherited settings.
- [ ] **E07:** Apply the policy to verification commands and browser launch, not just the model CLI. Inventory every child-process/browser entry point and document which policy it uses or why it is controller-only.
- [ ] **E08:** Avoid logging the discarded values. A diagnostic may name a removed variable, but never print its secret contents.
- [ ] **E09:** Preserve prompt-on-stdin, structured output, timeouts, process-tree cleanup, stop behavior and subscription-only billing safeguards.
- [ ] **E10:** Missing a required launch setting produces a useful local error. Do not repair it by setting an API key, signing in, reading unrelated secrets or broadening the environment.

Donor: the positive-list pattern in Cezar 0.16.3, pinned in [harness-research.md](../harness-research.md). Its allowed credentials are too broad for this project. Prefer a small implementation suited to Mission Control; copied code requires attribution and retained notices.

### P2 acceptance

Use local child programs and fake values, never real secret reads.

| Case | Expected |
|---|---|
| Arbitrarily named unrelated secret in parent test object | Missing in child |
| Provider/API-routing setting present in parent | Cannot select API billing in child |
| GitHub/SSH credentials present in parent | Missing from builder and verification environment |
| Node/shell/loader injection setting present | Not executed or inherited |
| Legitimate native tools and locale | Start with controlled settings |
| Rendering or metadata subprocess | Uses its declared policy; no broad inherited environment |
| Failure/timeout/stop | Existing structured outcome and child cleanup remain |
| Redaction diagnostic | Contains no supplied fake secret value |

## P3 experiment: what must actually run

Create isolated fixtures under an explicitly named development test directory in Ubuntu. Use a harmless sentinel in a separately named Linux fixture directory and one in a dedicated Windows fixture directory, created through its mounted path. Never enumerate the owner's other projects or read real credential files. Retain artifacts unless cleanup is explicitly authorized.

The candidate is Linux Bubblewrap, informed by Omnigent 0.20.0. Examine the pinned implementation and tests in [research-reconciliation.md](../research-reconciliation.md); do not import its Python framework.

- [ ] **I01:** Inventory availability without installing anything. If the mechanism or required kernel capability is missing, report the precise prerequisite. Ask before sudo. A missing tool is a blocked experiment, not a skipped pass.
- [ ] **I02:** Permit reads/writes needed for the assigned project only. Provide runtime programs and libraries read-only. Do not expose the host root, host home, Windows mounts or broad socket directories just to make setup convenient.
- [ ] **I03:** Frozen tests are readable but cannot be modified, replaced through a parent rename, deleted or rewritten through another path.
- [ ] **I04:** Coordinator state, approval events, lock data and authoritative policy are hidden or protected from worker mutation. The worker cannot invoke a writable control endpoint to forge approval.
- [ ] **I05:** A child and its descendants cannot escape through symlinks, traversal, alternate mounts, inherited file descriptors, the host process view or a controller socket. Test the applicable vectors explicitly; include attempts to reach the controller's environment/state through the process filesystem.
- [ ] **I06:** The Windows sentinel and unrelated Linux sentinel remain unreadable. Verify both denial and that the allowed project remains usable; a process that cannot do anything is not a successful boundary.
- [ ] **I07:** Selected protection fails closed. A missing tool, failed namespace setup or malformed mount rule launches no unprotected substitute.
- [ ] **I08:** Exercise read-only reviewer and writing-builder policies separately. Keep output capture, stdin, timeouts and stop/descendant cleanup.
- [ ] **I09:** Show the intended official-CLI authentication view using fake directories only. Expose at most the selected provider's required area. The provider CLI necessarily accesses its own login; do not claim to hide that login from the CLI itself. Token refresh and real CLI compatibility remain untried.
- [ ] **I10:** Prove a network-denied local mode with a harmless local server fixture. Document what additional network access the real worker/install stages would need. Do not confuse filesystem isolation with a complete outbound network restriction.
- [ ] **I11:** Explicitly test the current Codex fallback scenario. A failed read-only protection probe must not result in a full-access worker under the new selected policy.
- [ ] **I12:** Record tool/kernel versions, exact commands, fixture paths, expected/actual results, exit codes and untested vectors. Use only synthetic contents in published evidence.

## Experiment result and P3b gate

Write `docs/research/linux-isolation-result.md` with one outcome:

- **Demonstrated locally:** each required case has an actual passing result.
- **Blocked:** name the unavailable capability and the smallest concrete next action.
- **Failed:** retain the failing fixture and explain the observed escape or breakage.

If only some cases pass, the overall boundary is not demonstrated. Stop at the time cap and report before another loop.

P3b requires a reviewed addendum choosing the exact process wrapper, filesystem map, credential handling, network policy, supported launch contexts and failure messages. The experiment may produce an unsuitable mechanism; this spec does not predetermine success.

Potential integration files: the process wrapper, both runners, verifier, renderer and dispatcher launch context; shared contracts through the integrator. Do not weaken `requireContainerForBypass` or other existing safety gates merely to make a local experiment start. Replacing the current container assumption requires an explicitly reviewed gate in the addendum.

Only after the addendum may the integration replace the permissive read-only fallback. Existing hash/restore checks remain as defense in depth. User-scoped file permissions alone are not accepted as the boundary.

## Verification and evidence limits

P2 has focused fake-process tests and the full local suite. P3 has real local OS-process tests with harmless files, no AI. Record these as **tried for real: local isolation fixtures**, distinct from **tested here only with stand-in AIs**.

Real provider login/refresh, provider network access and product use remain **not tried**. A passing fake process is not evidence that a real Claude/Codex session works under the new boundary.
