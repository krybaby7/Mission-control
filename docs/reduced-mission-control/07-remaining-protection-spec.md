# Remaining file protection: implementation specification

**Current authority, 31 October 2026:** this remains the protection acceptance contract, now applied after local core reconstruction under [10](10-reconstruction-plan.md). The cloud delivery and fixture are unavailable; recovery is optional. Original I/ISO/T requirements are unchanged. This document does not authorize tests, typecheck/build, OS probes or protection activation while the owner's hold remains.

**Goal:** finish the enforced boundary that keeps Mission Control workers inside their assigned work, protects checks and owner decisions, and stops a launch when that protection is unavailable.

**Architecture:** retain the existing TypeScript engine and official CLI adapters. Reconstruct the P2 positive environment filter under 10, author a new Bubblewrap fixture where the cloud fixture is unavailable, then integrate a small controller-owned launch policy only after actual applicable evidence and a reviewed integration design support it. Do not replace the engine or import another harness. Existing research may inform the small wrapper; preserve pinned attribution and license notices for any copied code.

**Development model:** GPT 6.1 Sol, tool model ID **gpt-6.1-sol**, for every delegated implementer and reviewer. This does not change Mission Control's product models, including Haiku for light work.

This is a successor to [P2/P3](02-environment-and-isolation.md), additional to the core packages being reconstructed under 10. Read the current [HANDOFF](../HANDOFF.md) and [original build specification](../reduced-mission-control-spec.md). Use the [new-chat brief](08-next-orchestrator.md) to take over.

## 1. Owner scope and the testing hold

The owner asked for the remaining-build specification and a prompt for a new orchestrator that will deploy Sol agents. The owner also said there will be another discussion before testing.

**Current conservative rule: HOLD ALL TEST EXECUTION until the owner clarifies that discussion.** A question asking whether fake-AI development checks may continue while real-AI trials remain held was sent; no answer is assumed here.

While that hold is in force, the next orchestrator may:

- Read instructions and surviving source, optionally verify any recovered delivery, inspect tool versions without probes, create a working branch, and preserve existing work. Follow 10 for authorized inactive core reconstruction preparation.
- Author test fixtures, a proposed mount/launch design, inactive pure policy modules, and documentation.
- Perform source review and document/hash/format checks.
- Deploy the bounded Sol development workers described below.

It must not:

- Execute the product's unit/integration/browser suites, the OS isolation experiment, or an official provider CLI/account query.
- Activate the new protection path, declare it effective, or cross the P3-to-P3b integration gate without the required experiment.
- Commit code without the standing requirement that npm run check has passed.

If the owner explicitly allows development checks, record the exact authorization in HANDOFF and change the gate to **development checks allowed; real-provider trials held**. Only then may the fake-runner, browser and synthetic OS checks described here run. A later instruction in the new chat takes precedence. Silence, a selected UI default, this specification, and implementation-agent authorization are not test approval.

Real mc run, mc doctor --live, real provider metadata/account queries, product login, and real Claude/Codex work remain held until separate explicit approval. The later owner discussion may change this scope.

## 2. Starting point and optional recovery history

**Restart override:** the owner has chosen reconstruction from the preserved local checkout. The recovery steps below apply only if the exact dated artifacts become available; they no longer block local reconstruction. Follow 10 R0–R1 for the current source inventory/backup and preserve any reconstruction before comparing recovered artifacts. Never call reconstructed files a recovered copy.

### Historical reviewed implementation identity

| Item | Verified record |
|---|---|
| Hosted task | [Mission Control — cloud implementation](https://chatgpt.com/local/01a18414-fdad-7142-b79d-8ebce58e7061) |
| Thread / host | 01a18414-fdad-7142-b79d-8ebce58e7061 / durable |
| Cloud checkout / branch | /workspace/Mission-control / codex/reduced-mission-control-cloud |
| Base and unchanged Git HEAD | a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a |
| Reviewed delivery | /workspace/mission-control-delivery-20261029/ |
| Source archive | reduced-mission-control-20261029-source.tar.gz |
| Source archive SHA-256 | f0bab31abf5f80696630b4cfd5fe9924013efaf688e7149525213caee3b383b7 |
| Complete patch | reduced-mission-control-20261029.patch |
| Patch SHA-256 | b971ad8b538d31224802d0ef347c7fd4cb414a41952ef4a7922d31dcfa853a6b |
| Evidence archive | reduced-mission-control-20261029-evidence.tar.gz |
| Evidence archive SHA-256 | b7a3205865f8dd6fb811e6131e915d92ae88188d128b1c1b93dd15890fadb428 |
| Final frozen input digest | db88f6f5b96ce84eb7f85c51d413ee51fb5a8880ca9fb538c48b847a7746c69e |

**Tried for real: development commands. Tested with stand-in AIs:** the reviewed cloud tree passed typechecking, 5,724 tests across 101 files, with 14 browser tests skipped; npm run check and npm run build both exited 0. All 542 frozen input hashes were unchanged during those commands. Eight declared documentation updates followed; the final delivery manifest accounts for them. These are historical results for that exact tree, not results for new protection code.

The local checkout at ~/Mission-control was last inspected on codex/remaining-protection-preparation with older source and newer uncommitted research/specification documents. Its HEAD does not contain the cloud implementation. Re-inspect it and reconstruct the missing behavior on a new own branch under 10. Do not start from master, pretend the older source includes the reviewed changes, or overwrite local work with an older archive copy.

### Optional recovery procedure, retained for an exact artifact that becomes accessible

- [ ] RCV1. Read local HANDOFF and this document before importing anything. Record branch, HEAD, dirty paths and applicable AGENTS.md files. Preserve all existing uncommitted work.
- [ ] RCV2. Obtain the dated source/patch, manifest and evidence through the existing cloud task's file export. Keep the original delivery and the new delivery unchanged.
- [ ] RCV3. Verify the independent SHA-256 values above before applying or extracting. Inspect archive member paths first; reject absolute paths, traversal, unexpected links, repository metadata, credentials, or dependency/build directories that the manifest excludes. Match all source members to the manifest.
- [ ] RCV4. If ordinary export is unavailable, use an available documented transfer mechanism. A bounded text transfer of the compressed public patch through the existing task tools is acceptable: indexed base64 chunks, at most 12,000 characters per tool-output item, complete count/length recorded, no truncated items accepted, and final decoded/decompressed patch SHA-256 checked against the value above. Do not reconstruct missing bytes, use an unapproved public upload service, or push to GitHub as a transfer workaround.
- [ ] RCV5. Retain a verified copy outside the primary checkout in a dedicated Ubuntu directory such as ~/mc-reviewed-delivery-20261029. It must be a new directory, not an overwrite. Capture a non-destructive backup/manifest of current local documents before integration.
- [ ] RCV6. Create a feature branch using Ubuntu Git, never master. Use a separate Ubuntu worktree if safe and useful; keep its path and branch in HANDOFF. No Windows Git or project files on /mnt/c.
- [ ] RCV7. Apply source changes only after reviewing the complete patch, including untracked files. Use git apply --check before git apply. Resolve documentation overlaps explicitly: preserve the newest local instructions, this specification and its new-chat brief alongside the cloud implementation notes. Never use a force reset or blanket copy over the dirty checkout.
- [ ] RCV8. Compare recovered source/config/test inputs to the reviewed manifest. Document every intentional documentation-only difference. Source differences require review and, once authorized, a fresh check.
- [ ] RCV9. Read the recovered docs/research/linux-isolation-result.md, scripts/dev/linux-isolation-fixture.py, docs/reduced-mission-control/release-evidence.md and verification-20261029-review.md. These files exist in the reviewed delivery, not the old local source. Use their latest versions; early experiment excerpts are historical.
- [ ] RCV10. If transfer is blocked, record the missing artifact without claiming recovery. Continue the now-authorized local reconstruction under 10; recovery is not a prerequisite. Do not invent missing archive bytes or historical evidence.

The first delivery's missing process-exit record was resolved by the later fresh validation. The missing unchanged baseline from before the original implementation cannot be retroactively presented as an observed run. Preserve that B02 evidence limitation; a fresh recovered-tree check establishes a new starting point only.

## 3. What remains in scope

| Work | State before this specification | Action |
|---|---|---|
| Review attribution, retry/interruption evidence, dashboard disclosure, helper controls, allowance admission, plan integrity | Historically delivered in unavailable cloud source | Reconstruct P1/P4/P5/P6 plus 11 lessons under 10; validate afresh when authorized |
| Positive child environment filter | Historically delivered; absent from surviving local source | Reconstruct P2 from E01–E10; reuse the reconstructed policy for protection |
| Full Linux/WSL file boundary | Only historical partial cloud fixture reports; raw evidence unavailable | Author a new fixture and establish fresh applicable P3 evidence; P3b stays conditional |
| Browser checks | 14 skipped; cloud Chromium download was denied HTTP 403 | Keep as a later validation item; do not weaken or remove tests |
| Combined acceptance scenarios | V04 remains open | Track and execute after the testing hold is lifted |
| Real provider behavior, refresh and allowance effects | Revised implementation not tried with real providers | Hold for owner discussion and approval |
| Release PR / master | Not approved by this work | Hold; no automatic publication or merge |

Read-only availability check while preparing this specification found /usr/bin/bwrap, Bubblewrap 0.11.1, and WSL kernel 6.18.54.1-microsoft-standard-WSL2. **No isolation probe was run here.** Availability does not establish that namespaces, mounts or protection work. Cloud capability evidence does not prove WSL capability.

## 4. Design choice and its limits

**Preferred candidate: a small Bubblewrap-based boundary.** It follows the existing P3 research proposal and fits the Linux/WSL execution requirement; it does not assume the unavailable fixture or its evidence survived. Its actual supported recipe must be demonstrated; installing the program or passing a smoke command is insufficient.

Other approaches considered:

1. Keep environment filtering and restore changed files afterwards. This is already useful defense in depth, but it does not prevent reads of other files or temporary writes to protected state. It cannot satisfy this specification.
2. Introduce a container/VM service or replace the whole harness. This is a larger change and Docker is outside the current authorization. Do not select it automatically when the candidate fails.

If Bubblewrap cannot satisfy the required matrix on the intended host, stop at the experiment cap, preserve evidence and present the precise blocker and alternatives. Do not disable kernel/platform protections, broaden host access or silently choose a weaker mechanism.

This document defines the required behavior. **It is not the evidence-backed P3b integration addendum.** The next orchestrator writes that addendum after the experiment and has a separate Sol reviewer inspect it before activating the production path.

## 5. Required boundary

Assume worker code, project scripts, dependencies and generated pages can attempt actions outside the task. Treat the controller and its installed policy as trusted. This boundary is not a claim to resist a compromised host kernel or the human owner administering the PC.

| Area | Writing worker | Read-only reviewer | Verification / rendering |
|---|---|---|---|
| Assigned project content | Read/write only where the controller permits | Read only | Only explicitly required build/output paths writable |
| Frozen tests and authoritative check inputs | Read only; cannot replace their parents to evade this | Read only | Read only; changing them must not make a result pass |
| Controller state, approvals, locks and policy | Hidden or protected; no writable control endpoint | Same | Same |
| Other projects, host home and Windows mounts | Not exposed | Not exposed | Not exposed |
| Runtime binaries and libraries | Minimal required view, read only | Same | Same |
| Scratch and temporary files | Per-job private area | Per-job private area | Per-job private area |
| Provider configuration | Selected provider's minimal approved view only | Same if a provider is used | No provider login/configuration |
| Git metadata | Private, sanitized view if needed | Read-only sanitized view | No authority over controller branches or hooks |
| Network in the synthetic/offline profile | Denied | Denied | Denied |

An authorized test-rewrite stage needs its own controller-issued grant for a new or staged test set. The previously frozen authoritative set remains protected until the controller validates and adopts the replacement hashes. Engineers/reviewers cannot grant themselves test-author access. Test authors must still be able to create legitimate new checks without opening unrelated protected files.

Provider configuration paths are demonstrated with fake directories only. The provider CLI necessarily sees its own required login material; do not claim to hide that material from that same CLI. Actual login, token refresh and network compatibility remain untried until the owner allows them.

The first profile to prove is offline. The integration addendum must also state whether provider-network access is implemented or blocked. Any online profile needs an explicit reviewed network recipe and its own synthetic endpoint tests before real-provider trials. Do not grant host networking just to make a provider start, treat a proxy environment variable as a network firewall, or claim that filesystem protection restricts all outbound traffic. Local controller services, Unix sockets and other projects' loopback services must be considered in that recipe. No new general proxy service or broad network feature is authorized by this specification. If the available mechanism cannot provide the intended provider-network path without exposing local control services, report it as unfinished integration and obtain a new design/estimate; do not hide that gap behind a passing offline fixture.

## 6. Implementation requirements and file ownership

The paths below are a concrete work map, to be confirmed against the surviving source and reconstructed core before edits. New module names are proposed names for this package; do not claim they already exist.

| ID | Required behavior | Primary files |
|---|---|---|
| ISO01 | Controller constructs a typed launch context; worker text/config cannot supply arbitrary host mounts, executable wrappers, network access or an override that disables protection | New src/isolation/policy.ts; src/types.ts; src/config.ts |
| ISO02 | Canonicalize paths and reject traversal, mount escapes, unsafe symlink targets and invalid/overlapping grants. Freeze the approved recipe before spawn; account for replacement races rather than validating one path and using a changed one | New src/isolation/paths.ts and its tests |
| ISO03 | Expose only the assigned project and explicit dependencies. Never construct the view by binding the entire host root or home and masking a few known secrets | New src/isolation/bubblewrap.ts; newly authored fixture |
| ISO04 | Frozen checks remain unchangeable through write, unlink, rename, parent replacement, alternate path, symlink or hard-link alias. Same-user chmod or restoring files after execution is insufficient | src/isolation/policy.ts; src/verify.ts; fixture |
| ISO05 | Hide/protect authoritative mission state, approval records, locks and policy. A child cannot forge approval through filesystem or a writable socket/endpoint | src/dispatcher.ts; src/state.ts; src/checkpoint.ts; fixture |
| ISO06 | Git worktree links must not expose the shared repository/common Git directory, credentials, hooks or controller branch authority. Provide only the private/sanitized metadata needed for legitimate tools, or record incompatibility | src/git.ts; src/runners/worktree-guard.ts; launch policy |
| ISO07 | Close unintended inherited descriptors and provide an isolated process view. The child cannot read controller environment, descriptors, cwd or root through the process filesystem | src/util/process.ts; fixture |
| ISO08 | Children and grandchildren receive the same boundary. Timeout, abort and normal completion clean up only that job's descendants; unrelated processes remain untouched | src/util/process.ts; src/util/reap.ts; fixture |
| ISO09 | Enforce reviewer read-only access at the OS boundary, including descendant commands. Prompt restrictions and post-run restoration remain additional checks only | src/runners/codex.ts; src/runners/claude.ts; worktree guard |
| ISO10 | Missing tool/capability, malformed recipe, mount failure or failed protection probe starts no unprotected replacement process. Return a plain reason; never count unavailable protection as a passed check | src/isolation/bubblewrap.ts; src/doctor.ts; runner tests |
| ISO11 | Reuse the reconstructed P2 positive environment policy on every protected path. Only the selected provider's explicitly approved fake config view is exposed in fixtures; no other provider, GitHub or SSH credentials | src/util/child-env.ts; runner and metadata adapters |
| ISO12 | Prove offline network denial with a listener that is demonstrably reachable in the unprotected control case. A refused connection with no listener is not evidence. Include local socket/control-service access | fixture and new isolation integration tests |
| ISO13 | Inventory and cover worker, provider metadata, project install/check commands, browser launch and their helpers. Controller-only Git/diagnostic operations need a documented justification and their existing protections | src/runners/*; src/verify.ts; src/render.ts; src/util/process.ts; src/cli.ts; src/doctor.ts |
| ISO14 | Under selected required protection, a failed Codex read-only probe cannot silently select danger-full-access. Preserve requireContainerForBypass and existing permission safeguards; never spoof container state | src/runners/codex.ts; src/runners/index.ts; src/config.ts |
| ISO15 | Persist the selected protection policy for a mission; resume cannot silently downgrade it. Revalidate current host capabilities and actual paths before launch. Old missions are clearly labeled as lacking this new protection; do not manufacture historical protection evidence | src/types.ts; src/state.ts; src/run.ts; src/dispatcher.ts |
| ISO16 | Preserve stdin, structured output, callbacks, logs, signals and failure meaning. Protection errors cannot become successful reviews, verification, approval or missing/zero usage. Respect existing invocation accounting; do not refund/reset a durable reservation by guesswork | src/util/process.ts; src/executor.ts; runners; verifier |
| ISO17 | Preserve actual-family provenance, pending-write recovery, helper snapshots, supplied-check integrity and light-model selection | Existing provenance, helpers, plan-integrity and regression suites |
| ISO18 | Give the owner a short explanation of what was protected, what failed, and what was not tried. Reports/dashboard must not describe the legacy mode or a skipped probe as isolated | src/report.ts; relevant dashboard readers; docs |
| ISO19 | Add focused regression/fixture coverage for every requirement. Record host/tool versions, exact commands, exit codes, manifest identity and skipped/untried vectors | Tests listed below; evidence documents |
| ISO20 | Accept integration only after the P3 matrix and reviewed addendum; then the authorized full check/build and bounded review. A partial result remains partial | Coordinator-owned integration and HANDOFF |

The integrator alone owns src/types.ts, src/config.ts, src/state.ts, src/run.ts, src/dispatcher.ts and src/executor.ts. Other workers propose changes to these files. Do not refactor the dispatcher or introduce a general sandbox plugin framework.

### Contract decisions the addendum must settle

The addendum must contain actual choices and arguments, not placeholders:

- Public configuration names, validation, old-record behavior and new-setup default. A newly selected protected profile requires protection; old records with no policy are not labeled protected. Deliberately changing an old mission's policy must be recorded. Missing/invalid required policy must not silently select legacy behavior. Do not overwrite existing user settings.
- Controller-only launch-context type and exactly who creates it for each purpose.
- Actual source-to-destination filesystem map, private HOME/TMP, protected parent directories and Git metadata strategy.
- How path replacement races, inherited descriptors, host process visibility and sockets are prevented.
- How the wrapper integrates with process supervision and Playwright's direct browser launch.
- Exact offline network recipe, plus a clear block on any online profile that has not been designed and authorized.
- Provider config permissions demonstrated with fake data; no hidden promise about token refresh.
- Evidence-backed capability handling for the installed WSL version and any supported cloud version.
- Failure messages, policy persistence/resume, and the treatment of legacy runs.
- The explicit decision to preserve existing bypass/container safeguards and to remove the selected policy's permissive read-only fallback.

Do not add a configurable escape hatch allowing a worker to turn required protection off.

## 7. Acceptance cases to author now and run only after authorization

If scripts/dev/linux-isolation-fixture.py is absent, author a new fixture at that path and label all its results as new. If the exact old fixture is recovered later, preserve it and compare cases rather than overwriting either version. Historical summaries are not raw experiment evidence. Add focused TypeScript tests in src/isolation/policy.test.ts, paths.test.ts, bubblewrap.test.ts and test/isolation-boundary.test.ts as needed. Keep real OS fixtures distinct from fake-runner unit tests.

Use dedicated new directories for synthetic project, controller, unrelated-Linux and Windows sentinels. Suggested roots: ~/mc-isolation-fixtures/<run-id> in Ubuntu and a new mc-isolation-fixtures/<run-id> folder under this chat's authorized Windows workspace. A sentinel contains only a synthetic marker. Never enumerate real secrets or other projects. Derive the Windows-mounted path from the approved fixture directory; do not guess a user's home. Refuse to reuse a nonempty root without inspection. Retain evidence and fixtures; no broad cleanup.

| Case | Positive control / action | Required observation |
|---|---|---|
| T01 assigned project | Builder writes its allowed output; reviewer reads it | Allowed work succeeds |
| T02 unrelated Linux file | Outside the boundary, read the harmless sentinel; inside, attempt it | Control succeeds; worker read is denied |
| T03 Windows file | Same control/read test against the dedicated Windows sentinel from WSL | Control succeeds; worker read is denied; cloud-only absence is incomplete |
| T04 frozen file | Try write, unlink and replacement on synthetic frozen text | All attempts denied; controller hash unchanged |
| T05 parent/alias | Try parent rename/replacement, hard-link alias and alternate path to frozen text | No writable route to the protected object |
| T06 symlink/race | Resolve hostile symlink/traversal paths; swap a grant target during preparation | Launch rejects or access remains confined; no host fallback |
| T07 approval authority | Try to edit synthetic pending approval, state, lock and policy, and contact its synthetic control endpoint | No approval/state mutation or writable endpoint reachability |
| T08 Git common directory | Use a synthetic linked worktree and malicious local hooks/config | Required status/diff works if supported; no authority over shared metadata or hook execution |
| T09 process visibility | Attempt to inspect the synthetic controller through /proc paths | No controller environment, cwd, root or file-descriptor access |
| T10 inherited descriptor | Controller opens an unrelated synthetic file and tests a deliberately inheritable descriptor | Worker cannot read it; intended stdin/stdout remain usable |
| T11 descendants | Child and grandchild repeat the outside-file and frozen-file attempts | Same denials as the direct worker |
| T12 lifetime | Exercise timeout, abort, successful parent exit and descendants that create new sessions | Job descendants stop; unrelated control process survives |
| T13 read-only role | Reviewer attempts direct/descendant writes to project, tests and metadata | Writes denied; reads and structured output usable |
| T14 failed protection | Missing executable, unsupported namespace, invalid path and mount/probe failure | Zero unprotected substitute launches; explicit failure |
| T15 provider view | Two fake provider directories and one fake unrelated credential directory | Only selected, explicitly granted fake config visible; verifier/rendering see none |
| T16 network | Demonstrably reachable controlled listener, then identical connect from offline boundary | Positive control passes; protected attempt denied; sockets checked separately |
| T17 Codex fallback | Fake Codex reports failed native read-only protection probe | Required policy stops; no full-access fallback |
| T18 launch coverage | Fake official CLIs, metadata server, install/check command and browser launcher inspect their view | Every untrusted launch uses its declared boundary; no inherited broad environment |
| T19 recovery | Stop during launch/verification; resume after changing host capability | Policy remains required; unavailable protection stops; approvals and provenance remain honest |
| T20 compatibility | Old mission/config fixtures, new required policy, malformed/future records, fake stdout/schema and check failures | Defined compatible behavior; no fabricated isolation or success |

Any destructive attack in these cases is confined to expendable synthetic fixture contents and requires authorization to run the development tests. It never permits deleting existing project files, branches, backups or owner data.

A denied command alone is not enough: verify the intended allowed operation, the exact reason for denial, unchanged protected contents, and no substitute process. A passing test of generated command arguments is not equivalent to a real OS boundary test. A skipped case cannot close its requirement.

## 8. Work packages for the next orchestrator

These A–F packages cover protection after/alongside the core reconstruction sequence in 10. They are not a second instruction to redo the five core packages. Times are active engineering effort, not promises about elapsed agent time. Estimates exclude waiting for the owner or installation approvals.

| Package | Concrete output | Size / time / confidence | Gate |
|---|---|---|---|
| A. Confirm reconstructed-core starting point | Preserved source/docs, branch/input manifest, launch inventory and actual core validation state | Small; 1–2 hours; medium | Before protection integration; B may prepare independently |
| B. Complete experiment preparation | Missing fixtures, threat/path inventory, proposed launch policy, evidence table | Medium; 3–6 hours; medium | May be authored during testing hold |
| C. Execute remaining P3 experiment | All T01–T20 relevant OS cases, exact pass/fail/blocker record | Medium; capped at 4–8 active hours; low–medium | Owner permits development checks |
| D. Review integration design | Concrete P3b addendum and separate review disposition | Small–medium; 2–4 hours; medium | Complete applicable P3 evidence; no open critical boundary flaw |
| E. Implement protected launch path | Policy/wrapper, runner/check/browser wiring, persistence and messages | Large; provisionally 1–3 active days; low | Reviewed addendum; tests allowed |
| F. Integration and handoff | Focused regressions, combined checks, full check/build, reviewed delivery | Medium; 4–8 hours; medium | Development checks allowed; real-AI trials still held |

A time cap is a stop-and-report point, not permission to remove requirements. If the remaining experiment does not establish the boundary, report the smallest blocker instead of beginning E. Do not silently add another multi-day loop.

### Package A sequence

- [ ] Complete 10 R0–R1 and record which core stages are prepared versus integrated/validated. Use RCV1–RCV10 only for optional exact recovery.
- [ ] Record the testing authorization state before dispatch.
- [ ] Confirm native Linux Node >=22.12 and Git without installing anything.
- [ ] Inspect current Bubblewrap availability; do not assume the version above is still installed.
- [ ] After development-test permission, establish the preserved baseline and reconstructed-core results under 10. Otherwise label the current checkout untested; never reuse the cloud counts as current evidence.

### Packages B and C sequence

- [ ] Inventory all launch paths in the surviving/reconstructed core and classify their trust/purpose; refresh the map after runtime integration.
- [ ] Record the cloud experiment as historical reporting unless its raw files are actually recovered. Author missing fixtures and preserve all newly obtained observations.
- [ ] Author the missing cases with both permitted and denied controls; inspect them before execution.
- [ ] Draft the minimum candidate filesystem/process/network map.
- [ ] Stop at the testing hold. Once released for development checks, run the missing real OS fixtures under the platform's normal approved execution path.
- [ ] Record successful, failed, skipped and untried cases separately. Missing Windows evidence leaves the WSL claim open.
- [ ] Create docs/research/linux-isolation-result.md if absent, with a dated new result and explicit unavailable historical evidence. If present, add a new section. Do not rewrite partial history into a full pass.

### Packages D and E sequence

- [ ] Write docs/reduced-mission-control/isolation-integration-design.md with every decision in section 6 settled from evidence.
- [ ] Assign one separate Sol reviewer to the exact design and results. Resolve concrete findings within two correction rounds.
- [ ] Freeze shared contracts through the integrator.
- [ ] Implement pure policy/path validation, then wrapper supervision, then callers; one writer per shared file.
- [ ] For each confirmed behavior change, write a meaningful failing regression, observe the intended failure, implement the smallest correction and rerun its focused checks.
- [ ] Cover both regular and unusual paths: retries, metadata, stopped jobs, resumed jobs, direct browser spawn, fake missing capability and fake native-sandbox failure.
- [ ] Keep the selected protection disabled/unaccepted until the required evidence is present. If testing remains held, stop before integration activation and report authored-but-unverified work.

### Package F sequence

- [ ] Reconcile all ISO and original I01–I12 requirements to named evidence, not unchecked claims.
- [ ] Execute the ten cross-package scenarios from the original specification when authorized. Include helpers on/off; light-model escalation; same-family failover; stale review invalidation; preserved owner stops; strict unknown allowance; mixed code/document findings; supplied checks; literal strings; and old records.
- [ ] Complete browser setup/checks when authorized. Do not bypass the cloud's download policy, install system packages without approval or remove skipped checks to obtain a green report.
- [ ] Run npm run check and npm run build on the frozen integrated tree. Save command output and the exit code immediately in the same wrapper; record input hashes before and after.
- [ ] Inspect the exact diff, including new files. Obtain one bounded separate Sol review; at most two correction rounds without a new estimate.
- [ ] Update HANDOFF, the isolation result, configuration/permission guidance, release evidence and a requirement-to-evidence checklist.
- [ ] Preserve an exportable patch/source archive with hashes, exact test counts/skips and all remaining limitations. Do not publish, merge or delete.
- [ ] Stop and hand control to the owner before real-AI trials or any release decision.

## 9. Worker deployment and authority

The current new-chat prompt authorizes bounded inactive reconstruction/protection preparation workers, not implementation in this documentation chat. Active wiring and execution still require the owner's testing clarification under 10. Use at most **two Sol workers plus the orchestrator**. Workers do not create further workers or independent chats.

Preferred allocation:

- One implementer owns the assigned policy/fixture files; the orchestrator is the sole integrator for shared contracts and launch wiring.
- A second worker may independently inspect the threat/fixture matrix or later review the frozen diff, read-only.
- Concurrent code writers are allowed only with isolated Ubuntu worktrees, explicit non-overlapping ownership and an integrated baseline. If safe isolation/identity is unavailable, use one writer and a read-only reviewer.
- Pass model gpt-6.1-sol and fork_turns none with a self-contained brief. If that exact model is unavailable, stop and tell the owner; do not substitute.
- Keep the configured reasoning setting unless the owner changes it. Do not launch an extra council or broad research batch.
- Every brief names the branch/path, writable files, requirement IDs, testing hold, estimate, stop condition and evidence expected back.
- Do not delegate authorizing approvals, choosing a weaker protection mode, publishing, or changing master.

Small product models remain unchanged. Development-agent model selection is not permission to replace Haiku or change product provider pins.

## 10. Operating rules and final stop

On this PC, all project commands and Git run inside WSL Ubuntu, with source on its Linux filesystem. Edit through the corresponding Windows UNC path using UTF-8/LF. This restart uses local Ubuntu. No new cloud setup is requested. Historical cloud evidence cannot replace WSL/Windows cases.

Ask before sudo/system installs, Docker use, real provider work, any GitHub push/publication/PR, master changes or deletion. No own-branch push is authorized for this restart. This package does not need a push; keep it local/uncommitted unless the owner explicitly requests publication. Never invent Git identity or copy it from another project. Commit only after the required full check passes.

Never run scripts/dev/real-run-setup.sh, set API keys, create a repository-root CLAUDE.md, inspect other projects' secrets, rent a server, or change saved owner decisions. Ignore leader/CLAUDE.md's different-role instructions. Keep the repository public-safe.

Use plain words with the owner. Before each package give size, time and confidence. Use “run” in owner-facing wording. Label evidence as tried for real (synthetic OS/development commands), tested with stand-in AIs, source-reviewed only, or not tried.

The final report distinguishes: code authored, code checked, boundary demonstrated on each host, integration accepted, and real-provider behavior still untried. If testing is held, the correct result is **implementation preparation complete; protection integration and validation paused for owner discussion**, not “finished and safe.”

**Completion of this specification:** documentation only; no implementation agents, product tests, OS isolation fixtures, provider calls, commits, pushes or deletion. The next orchestrator must record the actual testing decision before proceeding through the execution gates.
