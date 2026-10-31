# Reuse research for Mission Control

Research date: 28 October 2026. Decision status: **no replacement selected**.
The owner's Perplexity report has now been received and checked. See [research-reconciliation.md](research-reconciliation.md) for the updated recommendation: evaluate a reduced Mission Control first, with selective reuse. The initial findings below remain evidence, not a replacement decision.

## Initial recommendation

Reuse existing work wherever it reduces the work still ahead. Do not fund a full rewrite merely to obtain a larger feature list.

The strongest current choices are:

1. **Cezar** for a configurable task workflow and selected TypeScript components.
2. **Orchestrator.inc** for worker coordination, recovery and a desktop/phone interface.
3. **Paperclip** if the aim expands into a persistent AI company with wider business tasks, approvals and spending controls.
4. **OpenHands Agent Canvas** for conversation, file and terminal components, or a broader runtime foundation.

None has demonstrated all of Mission Control's required behavior in this research. Keep whole-product replacement open, but require a comparison before migrating. The next small reuse candidate is Cezar's environment-filter design and tests, with a stricter Mission Control policy. Its current policy must not be copied unchanged.

This recommendation is an assessment from inspected source and limited local checks. It is not proof that keeping Mission Control is cheaper. Migration, missing safeguards and continuing maintenance must be included in that comparison. Past effort is not part of the decision.

## What was actually done

**Tried for real, development operations only:** inspected current official documentation and public repositories; installed Cezar's pinned development dependencies in a separate Ubuntu research checkout. This was not an AI product trial.

**Tested here only, with stand-in AIs:** Cezar v0.16.3 passed **82 selected upstream tests**. A separate continuation test **failed**, reproducing a workflow gap. Details follow.

**Not tried here:** real AI tasks in any candidate; their login flows; their phone interfaces; their isolation against a real agent; their complete test suites; Docker; product publication. Orchestrator, OpenHands and Paperclip were read, not installed or executed.

Two additional ChatGPT research workers performed the owner-approved, bounded, read-only Orchestrator and OpenHands reviews. Those reviews are source analysis by the same AI family, not independent provider trials.

No product AI login, API key, live health check, real agent task, GitHub write, production code replacement or branch deletion was performed. Candidate tests used disposable fixtures. Existing project data was retained. REA was not executed.

## The requirements used

The comparison covered these outcomes:

- Give a plain request and receive useful, checked work.
- Handle code, pages, documents and data, with honest reports.
- Use subscription accounts without silently switching to API billing.
- Stop before consuming the owner's reserved allowance.
- Stop for required owner decisions and resume after an answer.
- Keep agents away from unrelated projects and secrets.
- Preserve agreed acceptance checks and disclose same-family review.
- Recover from interruption without losing checks or repeating uncertain external actions.
- Work on the PC through Ubuntu, with a practical phone view.
- Save future implementation and upkeep effort.

Mission Control itself has gaps. Its current protection of frozen tests is not an operating-system boundary. Its container and real Codex task paths remain untried here. Its review fallback can hide same-family review until the agreed fix is made. The local baseline was **5,639 passed and 15 skipped**, not complete real-world proof. See [HANDOFF](HANDOFF.md), sections 7 and 10.

## Releases examined

| Candidate | Fixed version or scope | License inspected | Local execution |
|---|---|---|---|
| Cezar | v0.16.3, `69699d765f94434ece15d4b06b8124f3625d883a` | MIT | Selected stand-in tests only |
| Orchestrator.inc | v0.14.6, `e424538c94ab67940b555efec4d46d25122edec0` | Apache-2.0 | Not tried |
| OpenHands Agent Canvas | v1.34.0, `6c120073f5a1e1c838ba6fdd9a075c79ff997b98` | MIT | Not tried |
| OpenHands SDK / Agent Server | v1.58.1, `60192ed54db73ac658ac1a07462916126c32d3a0` | MIT | Not tried |
| OpenHands automation | 1.26.0, `3e8c54cb7c4f72f46178acef2ac8d3afc7cbe118` | MIT | Not tried |
| Paperclip | v2026.1023.0, `1b4c803816e82b0265c8422e1a804327a7ed8c54` | MIT | Not tried |
| Pi, DeepSeek Harness, Vibe Kanban | Current documentation screen only | No full dependency license review | Not tried |

These licenses permit substantial reuse subject to their conditions. Keep attribution and notices. Check licenses of the specific copied components and dependencies; a repository's root license does not settle every dependency or provider term.

## Cezar: useful workflow base, with a reproduced gap

**Source inspected; selected behavior tested here only.**

Cezar already has configurable steps, shell checks, bounded retry paths, task branches, review screens, account handling and a phone-oriented web interface. This is a close workflow match. Its implementation is TypeScript, which lowers the language barrier to component reuse. [Pinned README](https://github.com/open-mercato/cezar/blob/69699d765f94434ece15d4b06b8124f3625d883a/README.md)

Important distinctions:

- Its optional final review stop is off by default. Even when enabled, autonomous mode skips that stop. The four relevant engine tests passed locally.
- An explicit human-approval step is different. Six selected tests passed for approval, rejection, stopping, questions and recovery at that step. It is inaccurate to say Cezar has no enforced owner stops.
- Its Codex runner defaults to full access with no tool approval. A workspace-write option exists. Task branches alone do not contain filesystem access.
- Its environment filter removes many unrelated variables, but deliberately allows GitHub credentials and provider credential families. That conflicts with Mission Control's host-only GitHub and no-API-key policy.
- It records dollar costs and reacts to exhausted provider limits. No equivalent to Mission Control's 85% weekly, 97% short-window and 35% per-run reserve policy was located in the reviewed control paths. A spending display is not proof of that policy.

Sources: [review setting](https://github.com/open-mercato/cezar/blob/69699d765f94434ece15d4b06b8124f3625d883a/packages/cezar/src/runs/review-gate.ts), [workflow engine](https://github.com/open-mercato/cezar/blob/69699d765f94434ece15d4b06b8124f3625d883a/packages/cezar/src/workflows/run.ts#L7036), [Codex permissions](https://github.com/open-mercato/cezar/blob/69699d765f94434ece15d4b06b8124f3625d883a/packages/cezar/src/core/codex-app-server-runner.ts#L429), [environment filter](https://github.com/open-mercato/cezar/blob/69699d765f94434ece15d4b06b8124f3625d883a/packages/cezar/src/core/agent-env.ts).

### Local continuation reproduction

The scenario was: an AI step, a failing shell check, another shell check, then completion. The AI was Cezar's bundled stand-in. After the first check failed, the fixture was corrected and Continue was requested.

Observed result:

```text
run: waiting
build: done
verify: failed
downstream: pending
continue-1: waiting
downstream output: absent
```

The acceptance assertion that verification should finish failed. Continue resumed the conversation; it did not resume the remaining workflow. This confirms the central behavior described in [upstream issue 1733](https://github.com/open-mercato/cezar/issues/1733). Our result was **waiting**, not the issue's claimed final done state. We do not claim to have reproduced that extra detail.

The source explains it: `continueRun` appends a conversation continuation using the latest session. It does not use the failed workflow position. [Pinned code](https://github.com/open-mercato/cezar/blob/69699d765f94434ece15d4b06b8124f3625d883a/packages/cezar/src/workflows/run.ts#L3871)

No Cezar production fix was made. This is a research finding, not a failed Mission Control owner trial. The portable fixture is saved in [the reproduction file](research/cezar-continue-reproduction.test.ts.txt).

Other reported risks include [wrong account selection for quota holds, issue 1722](https://github.com/open-mercato/cezar/issues/1722), and [cumulative Claude cost counted repeatedly, issue 1704](https://github.com/open-mercato/cezar/issues/1704). Relevant source was inspected; those two failures were **not reproduced here**.

## Orchestrator.inc: strongest desktop and recovery candidate

**Not tried here. Source and upstream evidence inspected.**

The release has persistent coordinators and workers, separate task branches, a task board, reviewer flows, standalone tasks and mobile controls. Its durable process hosts, saved prompts and ownership checks are substantial work that could save implementation time.

However, its own capacity contract says Codex allowance readings are advisory and never control whether new work starts. Default Codex modes bypass approvals and the sandbox. Safer modes exist. Agent processes inherit the daemon environment. These require adaptation for our allowance and secret rules. [Capacity contract](https://github.com/OrchestratorInc/agent-orchestrator/blob/e424538c94ab67940b555efec4d46d25122edec0/backend/internal/domain/codex_capacity.go#L5), [permission mapping](https://github.com/OrchestratorInc/agent-orchestrator/blob/e424538c94ab67940b555efec4d46d25122edec0/backend/pkg/agentruntime/command.go#L198), [environment inheritance](https://github.com/OrchestratorInc/agent-orchestrator/blob/e424538c94ab67940b555efec4d46d25122edec0/backend/internal/adapters/chatdriver/processenv/processenv.go#L11)

Dedicated review is not automatically review by a different AI family. No frozen acceptance-test equivalent was located in the bounded review. Worker reports are recorded as claims, which is a useful design to borrow. [Review guide](https://github.com/OrchestratorInc/agent-orchestrator/blob/e424538c94ab67940b555efec4d46d25122edec0/frontend/src/docs/content/guides/review-loop.mdx), [report contract](https://github.com/OrchestratorInc/agent-orchestrator/blob/e424538c94ab67940b555efec4d46d25122edec0/backend/internal/domain/report.go#L68)

The exact release has successful upstream Go, frontend, mobile and command-line checks. The command-line jobs include Ubuntu, macOS and Windows. This is upstream automated evidence; it does not establish a WSL-to-phone journey or subscription task quality. A separate recovery note records historical authenticated Claude tests and identifies remaining gaps. [CLI checks](https://github.com/OrchestratorInc/agent-orchestrator/actions/runs/40026080651), [recovery evidence](https://github.com/OrchestratorInc/agent-orchestrator/blob/e424538c94ab67940b555efec4d46d25122edec0/docs/research/persistent-acp-chat-hosts.md)

[Issue 3280](https://github.com/OrchestratorInc/agent-orchestrator/issues/3280) reports repository hooks executing after trust-bypass flags are supplied. The relevant flags are present in the reviewed release; execution was not reproduced here. This makes trusted configuration and execution boundaries part of any adoption trial.

Much of the backend is Go. Reusing its designs and failure tests may be cheaper than copying its engine into a TypeScript product. The documented telemetry should be disabled in an isolated trial.

## OpenHands: broad components, external-agent approval gap

**Not tried here. Source and upstream evidence inspected.**

The current OpenHands repository is Agent Canvas. It is not the older all-in-one architecture. It supplies conversations, files, terminal views, external agents and separate automation services. Its release pins the SDK and automation versions shown above. [Pinned defaults](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/config/defaults.json)

The current external Claude/Codex bridge automatically answers permission requests. Its default modes are Claude `bypassPermissions` and Codex `agent-full-access`. The built-in OpenHands agent's approval settings do not prove owner approval on that external-agent path. [Permission response](https://github.com/OpenHands/software-agent-sdk/blob/60192ed54db73ac658ac1a07462916126c32d3a0/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1606), [default modes](https://github.com/OpenHands/software-agent-sdk/blob/60192ed54db73ac658ac1a07462916126c32d3a0/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1752)

The SDK does have a dollar-budget check. The Canvas budget component says users currently cannot set its per-task cap there. No equivalent subscription reserve policy was found in this review. Native mode has full filesystem access, and the external-agent process inherits environment variables and registered secrets. Container isolation is available but was not used or tested. [Budget check](https://github.com/OpenHands/software-agent-sdk/blob/60192ed54db73ac658ac1a07462916126c32d3a0/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L743), [Canvas limitation](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/src/components/features/conversation-panel/budget-display.tsx), [native warning](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/README.md).

Upstream evidence is mixed. The exact release's main CI succeeded, including a provider-backed OpenHands-agent test. Its separate mock browser checks reported **77 passed and 4 failed**. Neither result proves the current subscription adapters. An older published June smoke test records actual Claude/Codex replies; it used an older SDK. [Main CI](https://github.com/OpenHands/OpenHands/actions/runs/40519649187), [mock checks](https://github.com/OpenHands/OpenHands/actions/runs/40519649113), [historical ACP evidence](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/tests/e2e/live-acp/README.md), [coverage limits](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/docs/TESTING_MATRIX.md)

This is a component candidate. A complete replacement would still need our approval, allowance, acceptance-check and reporting policies.

## Paperclip: wider business scope, more operational machinery

**Not tried here. Pinned source and documentation inspected.**

Paperclip provides persistent teams, tasks, formal approvals, questions, budgets, recovery and wider business integrations. That makes it relevant to the owner's broader goal, not just coding.

Its spending controls are more substantial than a dashboard counter: source reserves estimated spend before dispatch and prevents duplicate dispatch. The source also states that estimates cannot cap the provider's actual bill. It has quota readings, but no equivalent to our complete subscription reserve policy was established. [Budget reservation code](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/budget-reservations.ts), [quota reading service](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/quota-windows.ts)

Its documentation carefully separates a question, a plan approval, a formal business approval and a tool permission. Recovery also distinguishes known failure from an external action whose outcome is unknown. Those are useful designs and tests to borrow. They are not locally verified behavior. [Approval coverage](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/feature-map/questions-and-approvals.md), [recovery coverage](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/feature-map/recovery.md)

Claude's execution adapter defaults to bypassing tool permission prompts. The default execution engine is ACP; an explicit CLI engine exists. The ACP selector rejects a local confinement request unless the CLI engine is chosen. These controls need a deliberate configuration and proof before adoption. [Permission defaults](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/claude-local/src/server/execute.ts#L440), [engine selection](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/claude-local/src/server/acp.ts#L65).

The project has a large database, server, UI and adapter surface. Its exact release has successful published release/build workflows, but those were not established as a complete task-acceptance suite in this review. Recent reports include a stable-release Claude sign-in parser problem on Linux, and older quota-recovery failures. These are reports, not failures reproduced here. [Linux report](https://github.com/paperclipai/paperclip/issues/17987), [quota report with older versions](https://github.com/paperclipai/paperclip/issues/17065)

Paperclip deserves a further trial if persistent business teams are central. It is not yet evidence of a simpler drop-in foundation for this PC.

## Other options and REA

**Not tried here; screened only.**

- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) is an extensible coding-agent component. Its documented minimal core omits a built-in team workflow. It could reduce runner work, but does not by itself replace the product.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is now a broader plugin platform. Its README explicitly labels it a developer preview with breaking changes. Do not dismiss it using an outdated claim that it is only a single-agent tool. Its integration and maintenance cost needs separate evidence.
- [Vibe Kanban](https://www.vibekanban.com/blog/shutdown) continues through community maintenance after the company's shutdown. It remains a possible code donor. The maintenance change makes it a weaker default foundation until current support is assessed.
- Plain official Claude Code or Codex remains an essential comparison baseline. If a team does not improve cost per verified task enough to justify its overhead, simplify it. No such real comparison was run in this research.

REA would help if a shipped program behaves differently from its available source, or its behavior is only available in a packaged artifact. All main candidates expose relevant source. Normal source inspection and small reproducible tests answered the current questions more directly. No REA target was analyzed.

## Subscription support: separate billing from product permission

**Official documents inspected; no authentication tried.**

OpenAI documents ChatGPT sign-in and allowance readings through Codex app-server. This is a documented integration route; it does not prove every third-party harness implements it correctly. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)

Anthropic's Help Center update of 7 October says Agent SDK and `claude -p` still use subscription limits when signed in with the Claude plan. Its June update also includes third-party app usage. Separately, the current SDK overview still requires prior approval for developers offering claude.ai login or rate limits in their products. These statements address different questions. We did not establish any candidate's approval status. Do not conclude that all SDK subscription use is impossible, or that a CLI wrapper automatically settles product permission. [Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

The official headless guide says `--bare` does not use subscription login. Do not adopt that flag as an isolation shortcut under the owner's no-API-key rule. Its guide also says resumed cost totals include earlier conversation spend, which matters when adapting cost accounting. [Headless guide](https://code.claude.com/docs/en/headless)

## Work and cost estimates

These are estimates of active engineering time for one implementer with AI assistance. They are not measured delivery times. They exclude separately approved real-AI trials and any paid services.

| Option | Size | Rough effort | Confidence |
|---|---|---|---|
| Adapt Cezar's environment-filter approach and focused tests to our stricter policy | Small–medium | 1–2 days | Medium |
| Trial one candidate's approval, interruption and fake-quota paths in isolation | Medium | 1–3 days | Medium |
| Reuse one substantial recovery/reporting component or its design | Medium | 2–7 days | Low–medium |
| Adopt Cezar as the base while preserving all our required controls | Large | 2–4 weeks | Low |
| Adopt Orchestrator as the base while preserving those controls | Large | 4–8 weeks | Low |
| Adopt OpenHands as the base while preserving those controls | Large | 3–6 weeks | Low |
| Adopt Paperclip as the base while preserving those controls | Large | 3–6 weeks | Low |

The full-switch estimates are planning ranges, not a ranking of code quality. They include changing defaults, adding missing controls, data/report migration and stand-in checks. A focused trial may change them substantially.

Research used no paid product runs. The two extra research workers used the allowance explicitly approved by the owner. No precise allowance cost was measured.

## Evidence required before choosing a replacement

Use the same short cases for Mission Control and each finalist:

1. A small code feature whose agreed check first fails, then passes.
2. A document or data task with checks suited to its output.
3. A failed step, a correction and resume through every remaining check.
4. A required owner stop, refusal, approval and restart while waiting.
5. A fake approaching quota limit and a same-family review fallback.
6. Attempts to read a harmless sentinel outside the allowed project, change frozen checks or publish without permission.
7. A forced interruption, including a simulated external action with an unknown outcome.

Begin with stand-in AIs and disposable local data. Do not put real secrets in the sentinel test. Do not perform real GitHub writes as part of it. Record observed behavior, not only test counts.

Only after these checks should the owner be asked to approve small, comparable real AI tasks. Measure checked output quality, time, allowance, owner interventions and required fixes. A full replacement earns selection by reducing future work while meeting the agreed controls. It does not need to preserve existing code.

The Perplexity findings have now been checked where they affect the decision; see research-reconciliation.md for corrections and new candidates. No further agent workers are approved by the existing two-worker authorization.

## Reproducing the local Cezar checks

The checkout and evidence are outside Mission Control, under:

```text
~/.cache/mission-control-research/2026-10-28/
  cezar/                 branch codex/research-cezar, pinned release plus research test
  test-home/             fake user home; no real product credentials
  npm-cache/
  evidence/
    cezar-install.log
    cezar-selected-tests.log
    cezar-approval-tests.log
    cezar-continue-reproduction.log
```

All commands ran in Ubuntu with native Linux Node and Git. Dependencies were installed using `npm ci --ignore-scripts --no-fund --no-audit`. No service or global candidate CLI was installed.

Each test invocation used an otherwise empty environment:

```bash
env -i HOME="$research/test-home" PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  XDG_CONFIG_HOME="$research/test-home/.config" \
  CEZ_DRY_RUN=1 CEZ_TELEMETRY=0 DO_NOT_TRACK=1 CEZ_NO_BANNER=1 \
  CEZ_SKILLS_AUTO_UPDATE=0 CEZ_AUTONAME=0 npm test -- <files and filters below>
```

Set `research="$HOME/.cache/mission-control-research/2026-10-28"` and run from `"$research/cezar"`.

First batch: seven files, **72 passed**, about 10 seconds:

```text
packages/cezar/src/core/agent-env.test.ts
packages/cezar/src/runs/review-gate.test.ts
packages/cezar/src/workflows/graph-run.test.ts
packages/cezar/src/workflows/check-retry-on.test.ts
packages/cezar/src/workflows/recover-autonomous.test.ts
packages/cezar/src/workflows/auto-resume.test.ts
packages/cezar/src/workflows/run-zero-cost-budget.test.ts
```

Second batch: two files, **10 passed**, about 3 seconds. Its **187 skipped** tests were deliberately excluded by the name filter, not missing prerequisites:

```text
packages/cezar/src/workflows/run.test.ts
packages/cezar/src/workflows/graph-system-nodes.test.ts
-t 'optional review gate|a human gate parks|a click on the card|any other answer rejects|Finish at a gate|a gate survives|ask-user feeds'
```

Reproduction: copy the saved text fixture into the research checkout as `packages/cezar/src/workflows/research-continue.test.ts`, preserving its contents. Run that file through the same environment and `npm test --`. Result on the pinned release: **one failed assertion**, about 2.5 seconds, with the state shown above. This failed acceptance expectation is retained as evidence; it is not part of Mission Control's passing suite.
