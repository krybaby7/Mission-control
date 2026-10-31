# Research reconciliation: Perplexity and local evidence

28 October 2026. **Research only. No architecture change has been approved or implemented.**

**Update:** The requested [keep/simplify/replace review](keep-simplify-replace.md) is complete. Use its concrete list and estimates for the next build decision. No product changes have been implemented.

## Recommendation

Evaluate a reduced Mission Control first. Keep its useful checks, approval records, allowance handling and reports. Use the official Claude Code and Codex programs for the AI work. Borrow specific components when they remove a demonstrated gap.

Do not start a second coordinator from scratch yet. Mission Control already has much of the small coordination layer proposed by Perplexity. The useful question is which parts to simplify, strengthen or replace.

OpenHands and Orchestrator remain possible larger replacements. Neither has established the required behavior here. Omnigent joins the component shortlist because its Linux isolation code addresses a known gap. HAPI is an optional phone interface candidate, not a replacement engine.

This is a recommendation, not a proven cost saving. No new product runs or tests were performed for this reconciliation.

## What the external report adds

The owner supplied [the Perplexity report](research/perplexity-harness-review-2026-10-28.md). It is preserved as supplied, with a provenance note. Its recommendations and estimates are not treated as verified facts.

The strongest additions are:

- Compare a simple official-tool workflow against larger teams. A larger framework must justify its future upkeep.
- Judge useful output, owner effort and technical rescue time, not feature counts.
- Test failed checks, missing allowance readings, pending approvals and uncertain publication outcomes before spending allowance on live trials.
- Examine Omnigent's operating-system restrictions, Pi's durable-state package and HAPI's remote interface.
- Distinguish personal/local integration from a future hosted commercial service.

The report largely agrees with the first local research pass. It ranks OpenHands first among complete products. That ranking is a judgment about breadth of features, not evidence that its Claude/Codex path meets the owner's approval rule.

## Corrections and qualifications

### 1. The small coordinator already partly exists

Source inspected in the local working branch:

| Proposed small-layer responsibility | Existing Mission Control source | What this establishes |
|---|---|---|
| Call official tools | `src/runners/claude.ts`, `src/runners/codex.ts` | Existing subprocess integration; not a new model-serving framework |
| Read Codex account and usage | `src/runners/codex-app-server.ts` | Already uses app-server over local standard input/output |
| Store job progress | `src/state.ts`, `src/dispatcher.ts` | Existing saved state and fixed stages |
| Preserve and run checks | `src/verify.ts`, `src/checks.ts` | Existing verification logic; stronger isolation remains needed |
| Record owner decisions | `src/checkpoint.ts` | Existing pending/answered records and event checks |
| Limit work and report results | `src/quota.ts`, `src/report.ts` | Existing controls to assess, not proof that every edge case is solved |

The Codex worker reads structured `codex exec --json` events. It does not scrape terminal pictures or presentation text. Moving all execution to app-server could add useful approval and session control, but should solve a specific need. It is not automatically a large saving over an adapter already built.

The current engine does make several role calls and contains substantial policy code. Simplification may still help. Preserve existing behavior while measuring alternatives; removing roles or changing checks needs a design and appropriate regression evidence.

### 2. Mission Control has limited historical real-AI evidence

The external report calls Mission Control unproven against real providers based on the information it received. That is too broad for our repository evidence.

The handoff records ten small real Claude runs on a cloud machine. They include checked code, writing, a page and data work, with several known failures. Those are historical records, not trials repeated by this agent.

A real Codex job, a product run on this PC, Docker execution and real GitHub publication remain untried. The local suite's 5,639 passes and 15 skips remain stand-in evidence. See [HANDOFF sections 4 and 10](HANDOFF.md) and [real-runs.md](real-runs.md).

### 3. OpenHands' approval gap remains in the newer SDK

Perplexity reviewed SDK 1.58.2. Canvas 1.34.0 actually pins Agent Server 1.58.1 in its [release configuration](https://github.com/OpenHands/OpenHands/blob/6c120073f5a1e1c838ba6fdd9a075c79ff997b98/config/defaults.json). These are separate version choices.

The newer SDK 1.58.2, commit `d2ee0cdea60825608c2f8906eb54e1d4d264fb42`, still automatically selects a permission response on its external-agent connection. Default modes remain Claude bypass-permissions and Codex full access. Its general confirmation-policy tests do not establish owner approval on this particular path. [Permission implementation](https://github.com/OpenHands/software-agent-sdk/blob/d2ee0cdea60825608c2f8906eb54e1d4d264fb42/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1652), [default modes](https://github.com/OpenHands/software-agent-sdk/blob/d2ee0cdea60825608c2f8906eb54e1d4d264fb42/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1800)

This was checked in source, not executed. OpenHands can remain a candidate, but I would not choose it ahead of proving this path.

### 4. Orchestrator's newer release does not resolve allowance admission

Version 0.14.7 exists, published on 28 October, at `e16e6f002213131036762c7e045580ae6d69a99e`. Its capacity contract still explicitly says allowance readings are advisory and do not decide whether new work may start. [Pinned source](https://github.com/OrchestratorInc/agent-orchestrator/blob/e16e6f002213131036762c7e045580ae6d69a99e/backend/internal/domain/codex_capacity.go#L5)

The release adds useful interface and recovery fixes. Only its release notes and selected relevant source were checked here; the earlier complete bounded review covered 0.14.6. Do not silently transfer all earlier test evidence to the newer version.

### 5. Cezar's recovery description is qualified by the local failure

Perplexity found documented restart recovery. Our earlier local test adds stronger evidence for one specific path: after correcting a failed check, Continue resumed the conversation but left that check failed and the next check pending.

Keep that failure in the comparison. The 82 selected passing tests did not cover away this gap. No Cezar tests were rerun during this reconciliation. [Local reproduction and details](harness-research.md)

### 6. Licenses and estimates need separate treatment

The external report left some licenses unresolved. The local research inspected Orchestrator's Apache-2.0 and Paperclip's MIT root licenses. Orchestrator 0.14.7's root license was checked again. This closes those root-license questions, not a complete dependency review.

The reports' estimates cover different amounts of hardening and upkeep. Neither is a quote derived from a complete change plan. Do not treat a multi-week estimate for a fresh small coordinator as required work when several of its parts already exist.

## New candidates checked

### Omnigent: promising source for Linux isolation

**Not tried here. Source and tests inspected only.**

Reviewed release 0.20.0, commit `bfd8ab5624e34aa72c01fb451e11c2a0e1aae3ee`, published 28 October. Its README labels the product alpha despite the release not being marked as a prerelease. The root license is Apache-2.0.

The Bubblewrap implementation builds an explicit filesystem view, has read/write path settings and optional network separation. It separates environment filtering from command arguments. Tests cover missing Bubblewrap, read-only defaults, exposed credentials and symlink behavior. This is a useful source of implementation and test ideas. [Implementation](https://github.com/omnigent-ai/omnigent/blob/bfd8ab5624e34aa72c01fb451e11c2a0e1aae3ee/omnigent/inner/bwrap_sandbox.py), [tests](https://github.com/omnigent-ai/omnigent/blob/bfd8ab5624e34aa72c01fb451e11c2a0e1aae3ee/tests/inner/test_bwrap_sandbox.py), [symlink tests](https://github.com/omnigent-ai/omnigent/blob/bfd8ab5624e34aa72c01fb451e11c2a0e1aae3ee/tests/inner/test_bwrap_symlink_mask_3265.py)

Configuration matters. The generic default can choose no sandbox when Bubblewrap is missing. Explicitly selecting `linux_bwrap` raises an error instead. The README separately says native terminal wrappers require Bubblewrap on Linux. Those are different launch paths, not a universal protection guarantee. [Generic wrapper](https://github.com/omnigent-ai/omnigent/blob/bfd8ab5624e34aa72c01fb451e11c2a0e1aae3ee/omnigent/sandbox/bwrap.py), [README](https://github.com/omnigent-ai/omnigent/blob/bfd8ab5624e34aa72c01fb451e11c2a0e1aae3ee/README.md)

A future trial must prove the exact path stops when protection is unavailable, protects frozen checks and hides harmless sentinel files outside the project, including Windows mounts. No sandbox, package or system dependency was installed here. Ask before any sudo installation.

### HAPI: optional remote interface

**Not tried here. Documentation and license inspected only.**

Version 0.31.3, published 27 October, describes controlling official agent sessions from a phone, web interface or native app. The root license is AGPL-3.0. It could avoid building a phone chat interface, but introduces another privileged service and license obligations. A separate deployment does not automatically settle those obligations. [README](https://github.com/tiann/hapi/blob/v0.31.3/README.md), [license](https://github.com/tiann/hapi/blob/v0.31.3/LICENSE)

Evaluate official remote controls first. No phone component is needed to settle the current build and verification questions.

### Pi: wider than the minimal coding-agent core

**Not tried here. Package documentation inspected only.**

The earlier screen of Pi's minimal coding-agent core did not cover its separate `pi-durable` package. Version 1.4.0 documents persistent conversations, child tasks and task graphs, while explicitly labeling its API experimental and subject to change without notice. This adds a component option; it does not demonstrate our full workflow. [Durable package](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md)

OpenAI lists Pi among open-source sign-in integrations. That is evidence about the provider route, not proof of the whole package's durability or isolation. [Official listing](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)

Nimbalyst and RunMaestro were additional names in the external report. They were not independently evaluated in this reconciliation and are not selected dependencies.

## Provider documentation clarified

**Documentation inspected. No login or model call performed.**

Anthropic's current legal page expressly permits an end user to sign in to an unmodified official Claude Code binary, including a hosted binary under the listed conditions. It separately restricts developers collecting or intermediating Claude credentials or offering their own Claude-account login. The hosting conditions also preserve the binary's built-in authentication choices. Our owner's choice to avoid API billing must not be confused with permission to alter a redistributed binary. This clarifies the earlier documentation uncertainty; it does not certify every candidate's route. [Official conditions](https://code.claude.com/docs/en/legal-and-compliance)

OpenAI distinguishes local/open-source app-server authentication from commercial or hosted services, and recommends Sign in with ChatGPT for the latter. Its documentation also labels the app-server command and WebSocket transport experimental. Pin and validate the intended integration; do not assume every advertised interface is equally stable. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)

Connected-app usage caps do not reserve allowance against consumption elsewhere. Any Mission Control reserve policy should be described as conservative stopping based on observations, not an exact account-wide reservation. [Official usage explanation](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)

The reported Codex 0.165.0 and Claude Code 2.1.312 releases and relevant fix notes were verified. They were not installed. Product pin upgrades require separate regression checks; a newer release alone is not proof of compatibility. [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.165.0), [Claude release](https://github.com/anthropics/claude-code/releases/tag/v2.1.312)

## Revised next steps

These are proposed steps, not authorization for product runs or a rewrite.

| Step | Work | Size / time | Confidence |
|---|---|---|---|
| 1 | Make a concrete keep/simplify/replace map for current Mission Control, with the cost of each change and the checks it must preserve. | Small, 2–4 hours | Medium |
| 2 | Prove one Linux isolation approach with harmless local fixtures, then adapt the environment filter and close the agreed same-family review reporting gap. Separate these into reviewable changes. | Medium, 1–3 days | Low–medium |
| 3 | Compare the reduced approach and at most one larger finalist on the same failure cases with stand-in AIs. Choose the finalist based on remaining needs, not feature count. | Medium, 1–3 days | Medium |
| 4 | After separate owner approval, compare a few small real tasks with plain official-tool use. Expand only if the results are close or uncertain. | Not estimated until exact tasks and allowance limits are agreed | — |

The external report's proposed 28 live runs are a later research program, not the next task. Start with fixture failures and a much smaller real comparison if authorized. Do not spend allowance on platforms that already fail required controls.

For each proposed removal, identify the behavior lost and why it is unnecessary. For each borrowed part, identify the exact gap it closes, its license and maintenance cost. Preserve existing tests and data. The owner's willingness to discard work is not permission to delete branches, files or history without asking.

## What changed in this session

Only research documents and the handoff were updated. The external report was saved with a clear attribution note. No implementation, new candidate installation, extra research workers, product AI call, Docker use, GitHub write, commit, branch deletion or provider login occurred.

Ubuntu was initially stopped for the source review, then briefly started for local code reading and recording the results. The task ends by stopping it again.

The first local research report and evidence remain available in [harness-research.md](harness-research.md).
