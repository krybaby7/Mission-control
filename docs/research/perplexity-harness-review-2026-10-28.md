# Owner-supplied Perplexity research

Received 28 October 2026. The text below is the external report as supplied. Claims and estimates are not automatically verified. See [the reconciliation](../research-reconciliation.md) for checks, corrections and the resulting recommendation.

---

# Recommendation for the CEO

**Do not replace Mission Control with another large orchestration system yet. First compare a much simpler setup—official Claude Code or Codex, one worker at a time, explicit checks, and a small approval/reporting layer—against OpenHands Agent Canvas.** Current official tools already supply substantial execution and integration machinery; adopting a larger platform does not remove the difficult requirements around reserved allowance, project isolation, safe recovery, and trustworthy acceptance evidence. [github](https://github.com/open-mercato/cezar/blob/main/docs/reference.md)

**OpenHands is the strongest replacement candidate to pilot; Orchestrator.inc is the strongest additional candidate if its demonstrated recovery work proves valuable.** Neither should be treated as a ready-made, safely autonomous CEO assistant: the evidence supports particular capabilities, not the complete workflow requested here.  See also Orchestrator’s [published recovery evidence](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/research/persistent-acp-chat-hosts.md). [github](https://github.com/OpenHands/OpenHands/blob/main/README.md)

This assessment uses information available on **28 October 2026**. It distinguishes source inspection, documentation, published live evidence, and unverified behavior; it does **not** claim that these products were installed and tested with real accounts during this review.

## What matters most

The main purchasing decision is not “which product has the most agents?” It is:

> **Which arrangement delivers acceptable results while leaving the smallest amount of safety-critical software under your ownership?**

For this business, a useful minimum is:

- A request becomes a short, owner-approved brief with fixed acceptance checks.
- A worker operates inside one project’s restricted environment.
- Deterministic checks run outside the worker’s control.
- A separately identified reviewer examines the result when review is worthwhile.
- Publication and destructive operations go through a separate approval boundary.
- A report explains what passed, what failed, who did the work, and what remains uncertain.
- An interruption produces either a verified continuation or an explicit “needs reconciliation”—not optimistic replay.

That design does not inherently require a company simulator, agent marketplace, visual workflow engine, or continuously running multi-agent team.

### Evidence labels

| Label | Meaning |
|---|---|
| **Real AI** | Published evidence reports authenticated provider execution; not independently reproduced here |
| **Tests** | Relevant automated assertions or stand-in-provider tests are present; their existence is not a fresh live-provider pass |
| **Docs** | Claimed in official documentation |
| **Source** | Inferred from the inspected implementation |
| **Unknown** | Adequate evidence was not established |

Mission Control itself remains **unproven against real providers** on the information supplied. Its stand-in tests are useful, but they should receive the same evidential discount as competitors’ stand-in tests.

## Ranked product shortlist

This ranks **replacement products**, separately from the recommended simpler official-CLI design.

| Rank | Candidate | Inspected version/date | Why it belongs |
|---|---|---|---|
| **1** | **OpenHands Agent Canvas ecosystem** | Canvas **1.34.0**, 27 Oct; SDK **1.58.2**, 25 Oct; automation **1.26.0**, 26 Oct | Broadest relevant combination of interface, agent execution, automation, and configurable backends. Its present architecture supports external agents rather than requiring replacement of Claude Code/Codex. [Current architecture](https://github.com/OpenHands/OpenHands/blob/v1.34.0/README.md).  [github](https://github.com/OpenHands/OpenHands/blob/main/README.md) |
| **2** | **Orchestrator.inc** | **0.14.7**, 28 Oct | Particularly relevant work on official-agent integration, approvals, persistent sessions, restart handling, and remote oversight. Its published evidence carefully separates fake-provider coverage from authenticated runs. [Release](https://github.com/OrchestratorInc/agent-orchestrator/releases/tag/v0.14.7), [status](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/STATUS.md). |
| **3** | **Omnigent** — stronger alternative discovered | **0.20.0**, 28 Oct | Worth investigating because local OS sandboxing and policy enforcement are central rather than merely worktree management. However, it explicitly labels itself **alpha**, and different execution paths have different sandbox behavior. [Pinned README](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/README.md), [sandbox implementation](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/omnigent/sandbox/bwrap.py).  [github](https://github.com/omnigent-ai/omnigent) |
| **4** | **Paperclip** | **2026.1023.0**, published 24 Oct | Strong organizational task management, attribution, permissions, approvals, and cost accounting. Consider it if managing a continuing organization of agents is the actual need—not merely completing individual CEO requests.  [github](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/README.md) |
| **5** | **Cezar** | **0.16.3**, 24 Oct | Relatively understandable CLI-backed workflows, check nodes, human gates, phone-friendly interface, and file-based state. Its documented execution defaults are materially weaker than the requested safety boundaries. [Pinned reference](https://github.com/open-mercato/cezar/blob/v0.16.3/docs/reference.md).  [github](https://github.com/open-mercato/cezar/blob/main/docs/reference.md) |

**Why OpenHands ranks above Orchestrator:** the owner’s work includes research, documents, data and reporting—not just software delivery—and OpenHands explicitly describes report-generating automations and separates interface, execution and scheduling responsibilities. That is a fit judgment, not evidence that its reports are accurate or its workflows recover safely. [github](https://github.com/OpenHands/OpenHands/blob/v1.33.0/README.md)

**Why Orchestrator remains close:** it has unusually useful published evidence about a difficult operational property: preserving a real authenticated agent’s running work through daemon replacement. That evidence is narrower than machine-crash recovery or exactly-once publication, but more meaningful than a feature checklist. [Recovery evidence](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/research/persistent-acp-chat-hosts.md).

## Subscription integration is conditional

### Claude: capability is not permission

Anthropic’s current help article says that **Claude Agent SDK, `claude -p`, and third-party-app usage still draw from subscription limits**, following the June pause; its October update also introduces separate monthly API credits for eligible plans. Using an API key with those credits is still a different billing path from using subscription allowance. **Evidence: Docs.** [Official help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

However, Anthropic’s SDK documentation still says third-party developers may not offer Claude login or subscription rate limits without approval. Its legal documentation distinguishes that prohibited credential integration from an end user signing into an **unmodified official Claude Code binary**, including on a platform hosting that binary under stated conditions. **Evidence: Docs; official statements require careful interpretation together.** [SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), [legal conditions](https://code.claude.com/docs/en/legal-and-compliance).

**Implication:** prefer a product that launches the user’s unmodified official Claude Code, lets the user authenticate through Anthropic’s own flow, and does not collect or replay Claude tokens through its own model client. “Our OAuth login works” is insufficient evidence of permitted integration. [Claude legal conditions](https://code.claude.com/docs/en/legal-and-compliance).

### OpenAI: distinguish integration routes

OpenAI now documents **Sign in with ChatGPT**, with separate permissions for identity and plan consumption; Pi is explicitly listed among open-source integrations. Connected-app usage shares the existing plan, and an app’s weekly percentage cap is **not a reserved portion** of that plan. **Evidence: Docs.** [Official documentation](https://developers.openai.com/codex/sign-in-with-chatgpt).

Codex App Server is officially documented as an embedding interface providing authentication, history, approvals and streamed events. Its documentation also distinguishes local/open-source app-server authentication from commercial or hosted services, for which the documented route is Sign in with ChatGPT; it separately warns that WebSocket transport is experimental. **Evidence: Docs.** [App Server documentation](https://developers.openai.com/codex/app-server).

**Implication:** this owner’s local installation and a future hosted commercial Mission Control are different compliance cases. Do not assume that a local open-source integration can be repackaged as a hosted subscription-backed service without revisiting provider permission. [App Server documentation](https://developers.openai.com/codex/app-server).

### Prevent unexpected paid usage

The acceptance test should verify the actual account and runtime configuration—not simply whether a login button exists.

- Remove API credentials and cloud-provider overrides from the worker’s environment unless deliberately authorized.
- Disable account-level extra usage or credits where applicable.
- Record authentication/billing mode before a job starts.
- Fail visibly rather than changing provider, account or billing route.
- Test optional platform features separately: Paperclip’s current “decision model” feature, for example, requires company-owned API keys and can run a billed setup test; it is separate from CLI-adapter compatibility. **Evidence: Docs.** [github](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/decision-models.md)

These are proposed controls. This review did not establish that any shortlisted product implements all of them as a subscription-only policy.

## Requirements comparison

**Configuration** means a supported mechanism exists but needs deliberate setup. **New work** means application code, an external control, or a meaningful integration is still needed. “Unknown” is not a pass.

### Spending and authority

| Candidate | Existing subscriptions | Reserved allowance | Owner approvals | Project/secrets isolation |
|---|---|---|---|---|
| **Official CLIs + thin coordination** | **Configuration:** native account login; lock out API/cloud overrides. [Claude terms](https://code.claude.com/docs/en/legal-and-compliance), [Codex integration](https://developers.openai.com/codex/app-server) | **New work:** consume provider limit observations conservatively; a dollar/token budget is not a subscription reserve | **Configuration + new work:** native tool approvals plus separate publication/destruction broker | **Configuration:** dedicated restricted runtime; ordinary workspace-write settings should not be assumed to hide unrelated readable files |
| **OpenHands** | **Configuration:** external Claude/Codex agents through ACP; verify exact adapter and billing mode.  [github](https://github.com/OpenHands/OpenHands/issues/14374) | **Unknown/new work:** no established proactive subscription-reserve guarantee | **Configuration + new work:** confirmation mechanisms do not automatically implement owner/business approval policy | **Configuration:** select restricted backend; local execution alone is not isolation.  [github](https://github.com/OpenHands/OpenHands/blob/main/docs/SELF_HOSTING.md) |
| **Orchestrator** | **Configuration:** installed Codex and Claude/ACP integrations; inspect chosen provider path. [Pinned status](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/STATUS.md) | **New work:** capacity display and reactive limit handling are not a reserve guard. [Limit handler](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/backend/internal/service/chat/usage_limit.go) | **Partly existing:** provider approval channel; business-action gates still need policy/integration | **New work:** its own status explicitly distinguishes agent permissions from OS/network containment. [Pinned status](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/STATUS.md) |
| **Omnigent** | **Configuration/verification:** supports subscription-backed native harnesses; route matters.  [github](https://github.com/omnigent-ai/omnigent) | **New work:** dollar-cost policies are not reserved subscription allowance. [Cost policy](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/omnigent/policies/builtins/cost.py) | **Configuration + verification:** policy hooks can ask/block; verify coverage of each native harness and external action | **Promising, configuration-dependent:** Bubblewrap/read-root controls; test fail-closed behavior per launcher. [Sandbox source](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/omnigent/inner/bwrap_sandbox.py) |
| **Paperclip** | **Configuration:** CLI adapters exist; optional API-only decision features must remain off. [Adapter](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/packages/adapters/claude-local/src/index.ts),  [github](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/decision-models.md) | **New work:** usage observations and financial budgets are not proof of proactive reserve stopping. [Usage service](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/server/src/services/ai-connection-usage.ts) | **Partly existing:** organizational approvals; do not assume every shell/network action passes through them | **Configuration/new work:** task privacy is not process isolation; adapter filesystem confinement is optional. [Adapter](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/packages/adapters/claude-local/src/index.ts),  [github](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/ISSUE-PRIVACY.md) |
| **Cezar** | **Existing/docs:** drives logged-in CLIs; verify inherited provider configuration. [Pinned reference](https://github.com/open-mercato/cezar/blob/v0.16.3/docs/reference.md) | **New work:** reported cost and `budgetUsd` do not establish subscription-reserve protection | **Insufficient by default:** graph human gates exist; cockpit cannot answer Claude permission prompts; optional diff review is not universal authorization.  [github](https://github.com/open-mercato/cezar/blob/main/docs/reference.md) | **New work:** worktrees are not sandboxes; documented default Codex mode is full-access/no approvals.  [github](https://github.com/open-mercato/cezar/blob/main/docs/reference.md) |
| **Pi** | **ChatGPT: documented route. Claude: technical OAuth exists, permission concern remains.** [OpenAI documentation](https://developers.openai.com/codex/sign-in-with-chatgpt), [Claude OAuth source](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/auth/oauth/anthropic.ts) | **Unknown/new work** | **New work:** do not infer an enforceable owner gate from an extension-capable agent | **New work:** use external containment; OAuth and agent functionality do not provide project isolation |
| **DeepSeek Harness** | **Not established** for the required Claude/ChatGPT subscription arrangement | **Unknown** | **Not established** as the required business approval boundary | **Explicit caution:** experimental, unaudited, not to be treated as secure/production-ready. [Safety statement](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974a/SAFETY.md) |
| **Vibe Kanban** | **Docs:** uses authenticated coding agents.  [github](https://github.com/BloopAI/vibe-kanban/blob/4deb7eca8f381f7cbc1f9d15515a9ab8f8009053/README.md) | **Not established** | **Not established** for complete business-action enforcement | Workspaces/branches are not sufficient isolation.  [github](https://github.com/BloopAI/vibe-kanban/blob/main/README.md) |

### Continuity and results

| Candidate | Interrupted-work recovery | Fixed checks and truthful attribution | Non-code outputs | WSL2 and phone oversight |
|---|---|---|---|---|
| **Official CLIs + thin coordination** | Session resume exists; **new work** for durable job stages and uncertain external outcomes. [App Server](https://developers.openai.com/codex/app-server) | **New work:** immutable check manifest, artifact IDs, worker/reviewer records | General file/tool execution; document/data quality must be checked separately | Suitable Linux execution path; add official remote control or a separately evaluated phone client |
| **OpenHands** | Persistence mechanisms exist; **unknown** end-to-end exactly-once publication/check preservation | **New work:** bind approvals/check results to artifact revision and named actors | Explicitly includes report-generating automations; accuracy unproven.  [github](https://github.com/OpenHands/OpenHands/blob/v1.33.0/README.md) | Browser-based self-hosting; secure backend access explicitly required. Exact WSL2/phone journey needs testing.  [github](https://github.com/OpenHands/OpenHands/blob/main/docs/SELF_HOSTING.md) |
| **Orchestrator** | **Real AI, limited scope:** published Claude survival through daemon replacement; stand-in coverage is broader. Not machine-loss proof. [Recovery evidence](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/research/persistent-acp-chat-hosts.md) | Review machinery exists; **new work** for an owner-approved, immutable acceptance contract | Possible through underlying agents; interface remains engineering-oriented | Remote/mobile work exists; exact Ubuntu/WSL2 operation remains an acceptance test.  [github](https://github.com/OrchestratorInc/agent-orchestrator/releases) |
| **Omnigent** | Restoration/recovery code exists; **unknown** safe handling of uncertain external effects. [Recovery source](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/omnigent/server/child_session_recovery.py) | **New work:** policies and shared sessions are not acceptance-evidence guarantees | Broad harness/tool design; business-report quality unproven | Web/phone support claimed; README directs native wrapper users to Linux/macOS/WSL.  [github](https://github.com/omnigent-ai/omnigent) |
| **Paperclip** | Extensive recovery model/tests; its own evidence guide says browser mocks do not prove runner recovery. [Recovery evidence map](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/feature-map/recovery.md) | Organizational attribution exists; **new work** to prove acceptance checks cannot be silently changed | Tasks, documents and work products fit wider business work.  [github](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/ISSUE-PRIVACY.md) | Server/browser design fits remote operation; exact PC and interruption behavior unverified |
| **Cezar** | Docs describe parked-workflow restart recovery; **unknown** external-action reconciliation guarantee. [Pinned reference](https://github.com/open-mercato/cezar/blob/v0.16.3/docs/reference.md) | Check nodes and review children exist; **new work** for immutable checks and independent provenance | Agent outputs possible, but primarily coding/diff-oriented | Responsive interface claimed; local CLI operation plausible, not a demonstrated WSL2 deployment here. [Pinned README](https://github.com/open-mercato/cezar/blob/v0.16.3/README.md) |
| **Pi** | Durable orchestration package exists, but that is a component, not proof of this workflow. [Durable package](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md) | **New work** | Flexible building block; not a ready CEO reporting product | Requires additional interface/operations work |
| **DeepSeek Harness** | **Unknown** against the required failure scenarios | **Unknown/new work** | Not established as a checked business-output system | Preview status makes it unsuitable as the initial operational foundation. [Safety statement](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974a/SAFETY.md) |
| **Vibe Kanban** | No sufficient current evidence for the required guarantees | Coding review UX is not proof of fixed acceptance/provenance | Primarily coding workspaces | Maintenance situation outweighs interface convenience.  [github](https://github.com/BloopAI/vibe-kanban/releases/tag/v0.1.44-20260424091429) |

### The allowance limitation

**No shortlisted product was established to provide the requested proactive subscription-reserve guarantee out of the box.** The inspected mechanisms include usage display, dollar budgets, provider-capacity observations and reactive handling; those are different controls. Examples include Cezar’s cost/budget fields, Orchestrator’s usage-limit handler and Paperclip’s usage-observation service.  [Orchestrator handler](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/backend/internal/service/chat/usage_limit.go), [Paperclip service](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/server/src/services/ai-connection-usage.ts). [github](https://github.com/open-mercato/cezar/blob/main/docs/reference.md)

For a practical conservative guard, require:

- Fresh observations for every applicable allowance window.
- A safety margin above the owner’s reserve.
- One worker initially, avoiding concurrent consumption races.
- No new turn when observations are missing or stale.
- Cancellation and reconciliation rules for work already in flight.
- Explicit treatment of usage consumed by other apps or people.

Even that should be described as a **conservative operating control**, not an exact reservation guarantee. OpenAI explicitly states that its connected-app percentage limits are caps, not reserved allowance. [Official plan-usage documentation](https://developers.openai.com/codex/sign-in-with-chatgpt).

## Strongest evidence by candidate

### OpenHands Agent Canvas

**For — Docs/source:** OpenHands’ current flagship repository is **Agent Canvas**, not the older monolithic OpenHands application. Its execution API lives in `software-agent-sdk`; scheduling/webhooks live in `automation`; the interface supports multiple agent backends and external ACP agents. Old architectural descriptions should not drive this decision. [github](https://github.com/OpenHands/OpenHands/issues/14374)

**For — Source/tests:** the SDK contains explicit confirmation-policy tests, ACP contract tests, persistence tests and credential-handling tests. These are valuable implementation evidence, but they do not establish that a complete Claude/Codex subscription workflow passes the owner’s safety requirements. [SDK tests](https://github.com/OpenHands/software-agent-sdk/tree/v1.58.2/tests/sdk), [confirmation-policy tests](https://github.com/OpenHands/software-agent-sdk/blob/v1.58.2/tests/sdk/security/test_confirmation_policy.py).

**Against — Docs:** self-hosting documentation warns that the local agent can read/write the machine, execute commands and use the network, and that access to the agent server grants corresponding power. A default local backend should therefore not be confused with per-project isolation. [github](https://github.com/OpenHands/OpenHands/blob/main/docs/SELF_HOSTING.md)

**Relevant defects:** issue #17135 reports subscription-profile/preflight problems specifically with Canvas **1.16.0** and SDK/server **1.44.0**. Issue #17794, dated 28 September, reports startup failure when an agent server already occupies the expected port. Neither report, by itself, proves Canvas **1.34.0** still has that defect; both should become targeted regression tests. [github](https://github.com/OpenHands/OpenHands/issues/17794)

**Verdict:** best broad replacement pilot; not a verified turnkey replacement.

### Orchestrator.inc

**For — Real AI:** its recovery note reports authenticated Claude and OpenCode runs surviving daemon replacement, including fresh September runs. It explicitly declines to claim equivalent authenticated survival for several other providers. [Published evidence](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/research/persistent-acp-chat-hosts.md).

**For — Source/tests:** the design includes detached provider hosts, durable journals, stable interaction identities, controller-generation fencing and approval acceptance before database projection. That is directly relevant to avoiding duplicate controllers and lost approval state. [Published design and test boundaries](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/research/persistent-acp-chat-hosts.md).

**Against — scope:** the same note explicitly separates daemon replacement from host/machine failure. Its status document also says native permission modes and prompts are not OS/network isolation; some harness integrations require explicit bypass-permissions operation. [Recovery limitations](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/research/persistent-acp-chat-hosts.md), [status](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/STATUS.md).

**Relevant recent changes:** October release notes include changes to retaining usage-limit refusals through wake replay, review-size limits and mobile pairing. These indicate active work on relevant areas, but are not proof that all restart/limit combinations are correct. [github](https://github.com/OrchestratorInc/agent-orchestrator/releases)

**Verdict:** serious finalist if continuity and software-delivery workflows dominate. Do not inherit its entire expanding provider matrix unnecessarily.

### Omnigent

**For — Docs/source:** it supports native official-agent wrappers, policy hooks and Bubblewrap-based Linux containment, plus browser/phone access. These address real gaps rather than merely organizing branches.  [Pinned README](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/README.md). [github](https://github.com/omnigent-ai/omnigent)

**Against — Source:** sandbox behavior is path-dependent. The README says native terminal wrappers require Bubblewrap on Linux, while the generic sandbox module describes a default fallback to `none` when Bubblewrap is missing. Those statements need not contradict each other, but they mean “the product supports sandboxing” is not enough: pin the backend and test the actual launcher’s failure behavior. [README](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/README.md), [generic backend wrapper](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/omnigent/sandbox/bwrap.py).

**Against — maturity:** version **0.20.0** still identifies the project as alpha. Recovery implementations and many tests are present, but this review did not establish published real-provider evidence for the complete approval/isolation/recovery chain. [Pinned README](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/README.md), [recovery implementation](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/omnigent/server/child_session_recovery.py).

**Verdict:** valuable challenger and source of components; too early to select solely on its attractive architecture.

### Paperclip

**For — Docs/source:** it has a business-oriented task/agent model, authorization machinery, private tasks/projects and recorded work products. Those fit a CEO’s organizational needs better than a terminal-only interface. [github](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/README.md)

**For — evidence discipline:** its recovery feature map explicitly distinguishes mock-based browser reconnection tests from runner-restart evidence and instructs operators to inspect providers before repeating operations with unknown external outcomes. That is an unusually useful acknowledgment of the actual failure problem. [Recovery feature map](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/feature-map/recovery.md).

**Against — source:** the inspected `claude_local` adapter documents `dangerouslySkipPermissions` defaulting to true, with optional filesystem confinement off by default. It also distinguishes ACP and CLI engines. These findings apply to that adapter/configuration—not automatically every newer native-runtime path. [Pinned adapter](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/packages/adapters/claude-local/src/index.ts).

**Against — complexity/billing:** organizational budgets and approvals do not automatically govern arbitrary external actions, while optional decision-model functionality introduces an API-key-only path. [github](https://github.com/paperclipai/paperclip/blob/v2026.1023.0/server/src/services/authorization.ts)

**Verdict:** choose only if the business actually needs persistent agent organization and delegation. Otherwise it risks replacing one orchestration product with a larger one.

### Cezar

**For — Docs/source:** its workflow graph supports agents, checks, human gates, dispatch and nested workflows; documentation describes restart recovery for parked workflows. Its file-based state and CLI-backed execution are relatively approachable. [Pinned reference](https://github.com/open-mercato/cezar/blob/v0.16.3/docs/reference.md).

**Against — explicit defaults:** documentation says Claude’s normal allowed tool set can grant unrestricted shell access; the cockpit cannot answer Claude permission prompts; Codex’s default auto mode uses `danger-full-access` with `approvalPolicy: never`. The optional diff-review gate is off by default and autonomous runs skip it. [github](https://github.com/open-mercato/cezar/blob/main/.env.example)

**Important distinction:** a `gate.human` node can pause a planned workflow. It does not prevent an agent with shell/network authority from performing a publication or destructive action before reaching that node. The default tool-access description makes this a substantive integration gap, not a cosmetic configuration issue. [github](https://github.com/open-mercato/cezar/blob/main/docs/reference.md)

**Verdict:** useful workflow/UI donor or constrained pilot, but not the strongest foundation for the requested authority boundaries.

## Why other candidates fall short

### Pi

Pi **1.4.0**, released 21 October, deserves consideration as a smaller agent/runtime toolkit, especially its durable orchestration package. Its ChatGPT integration is supported by an official OpenAI listing, which is stronger evidence than an unofficial OAuth implementation alone. [Durable package](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md), [OpenAI integration list](https://developers.openai.com/codex/sign-in-with-chatgpt).

However, Pi’s source also implements direct Anthropic subscription OAuth. That technical capability must not be presented as proof of permission to offer the integration; Anthropic’s developer restrictions still matter. [Pi OAuth source](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/auth/oauth/anthropic.ts), [Anthropic conditions](https://code.claude.com/docs/en/legal-and-compliance).

**Assessment:** component candidate, not a replacement for the CEO-facing product. Adopting it would leave substantial interface, approvals, containment and acceptance-evidence work.

### DeepSeek Harness

The inspected repository snapshot was **`f3803c96974a`**; no published release was established. Its own safety statement calls it experimental developer-preview software, unaudited and not production-ready. [Pinned safety statement](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974a/SAFETY.md).

**Assessment:** do not select it as the operating foundation under these requirements. Subscription compatibility, owner authorization and safe recovery remain insufficiently established.

### Vibe Kanban

The relevant release is **0.1.44**, dated 24 April. That release explicitly added a sunsetting notice; the repository README continues to carry it. The project should not be assessed using older descriptions of a fully supported commercial product. [github](https://github.com/BloopAI/vibe-kanban/blob/main/README.md)

Later reports describe stale website content and availability problems, but those reports are not proof that every local open-source installation is broken. Equally, “community maintained” is not evidence of a dependable maintenance successor. [github](https://github.com/BloopAI/vibe-kanban/issues/3433)

**Assessment:** do not start a new dependency on it without identifying an active successor, release owner and credible maintenance record.

### Other alternatives screened

**Nimbalyst 0.81.7** is relevant to the mixed-output requirement: its current repository describes documents, diagrams, mockups, code and linked sessions, under MIT. **RunMaestro 1.0.2** offers another orchestration interface but uses AGPL-3.0. Neither displaced the shortlist because this review did not establish stronger evidence for the critical safety/recovery requirements. [Nimbalyst release](https://github.com/nimbalyst/nimbalyst/releases/tag/v0.81.7), [Nimbalyst README](https://github.com/nimbalyst/nimbalyst/blob/v0.81.7/README.md), [Maestro release](https://github.com/RunMaestro/Maestro/releases/tag/v1.0.2), [licence](https://github.com/RunMaestro/Maestro/blob/v1.0.2/LICENSE).

## Licences and dependencies

| Software | Established licence position | Consequence |
|---|---|---|
| Codex | **Apache-2.0**. [Repository](https://github.com/openai/codex/tree/rust-v0.165.0) | Suitable open-source foundation, subject to provider-service terms |
| Claude Code | Not an open-source substitute for the provider service; use governed by Anthropic’s applicable terms. [Legal documentation](https://code.claude.com/docs/en/legal-and-compliance) | An open-source wrapper does not make Claude Code or its service unrestricted |
| OpenHands Canvas, SDK, automation | **MIT** in the inspected repositories. [Canvas](https://github.com/OpenHands/OpenHands/blob/v1.34.0/LICENSE), [SDK](https://github.com/OpenHands/software-agent-sdk/blob/v1.58.2/LICENSE), [automation](https://github.com/OpenHands/automation/blob/1.26.0/LICENSE) | Generally convenient for reuse; agent/provider dependencies retain separate terms |
| Omnigent | **Apache-2.0**. [Licence](https://github.com/omnigent-ai/omnigent/blob/v0.20.0/LICENSE) | Convenient reuse terms; optional integrations add dependency and service obligations |
| Cezar, Pi, DeepSeek Harness | **MIT** in inspected source. [Cezar](https://github.com/open-mercato/cezar/blob/v0.16.3/LICENSE), [Pi](https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE), [DeepSeek](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974a/LICENSE) | Licence permissiveness does not establish provider permission or production safety |
| HAPI | **AGPL-3.0**, including inspected CLI licence. [Licence](https://github.com/tiann/hapi/blob/v0.31.3/LICENSE), [CLI licence](https://github.com/tiann/hapi/blob/v0.31.3/cli/LICENSE) | Prefer evaluating it as a separate application; modifications/integration need appropriate licence review |
| Orchestrator, Paperclip, Vibe Kanban | **Final licence determination not completed in this review** | Blocking check before copying code or committing to redistribution; do not assume their licence from an older owner/version |

This is **not a complete transitive-dependency audit**. Before adoption, generate a dependency inventory for the exact pinned installation, examine optional plugins and bundled agents, and separate software-licence obligations from provider authentication and billing terms.

## Top two adoption options

### Option A: official tools, thin layer

**Recommended first.**

Use the official programs for execution and keep coordination deliberately small. Codex’s documented integration interface already exposes threads, resume, approvals, interruption, review and streamed events; Claude supports subprocess-driven `-p` execution and structured output. [Codex App Server](https://developers.openai.com/codex/app-server), [Claude SDK/CLI comparison](https://platform.claude.com/docs/en/agent-sdk/overview).

The layer you own should do only six jobs:

1. Store the approved brief and acceptance manifest.
2. Start one worker in a restricted project environment.
3. Record job stages and artifact revisions durably.
4. Run checks and, when justified, a separate reviewer.
5. Broker owner-only external actions.
6. Produce a short evidence-backed report and conservative allowance stop.

**Avoid a general workflow engine initially.** A fixed state machine—brief approved → build → checks → review → owner decision → publish—is easier to inspect and test than arbitrary agents rewriting their own process.

**Estimated effort, not measured delivery promises:**

| Stage | Broad range |
|---|---|
| Useful prototype | **1–2 engineer-weeks** |
| Hardened single-owner version | **4–8 engineer-weeks** |
| Routine upkeep after stabilization | **1–3 engineer-days/month**, with occasional larger provider changes |

These estimates assume an experienced developer, a narrow task catalogue and reuse of existing checks where sound. Reliable allowance guarding, external-action reconciliation and restricted credential handling could push work beyond the range.

**Future work saved:** custom agent loops, model-provider abstraction, elaborate delegation and much of session handling. **Work retained:** precisely the business-specific controls no platform has been established to solve completely.

### Option B: OpenHands as the interface/runtime

Adopt **Canvas + Agent Server/SDK**, initially without broad unattended automation. Use one narrowly configured Claude/Codex path, a project-contained backend and the same external approval/checking contract as Option A. The current repository split makes it possible to adopt interface/runtime capabilities without assuming every automation feature is necessary. [github](https://github.com/OpenHands/OpenHands/blob/main/README.md)

Keep Mission Control code only where it already provides useful, independently testable acceptance checks, approval records or reporting. Do not preserve its planner, agent hierarchy or recovery abstraction simply because it exists.

| Stage | Broad range |
|---|---|
| Constrained adoption pilot | **2–4 engineer-weeks** |
| Hardened owner workflow | **6–12 engineer-weeks** |
| Routine upkeep | **2–6 engineer-days/month**, plus upgrade/regression bursts |

These are planning estimates. Integration can be cheaper if Canvas already fits the desired interaction; it can be more expensive if its state model must be bent into Mission Control’s architecture.

**Future work saved:** maintaining a custom general-purpose interface, agent connection UX, event display and some execution infrastructure. **Costs added:** several coordinated projects, adapter/runtime compatibility, deployment security and a broader regression surface. [github](https://github.com/OpenHands/OpenHands/blob/main/docs/SELF_HOSTING.md)

**When Orchestrator should replace Option B:** if the trial shows that software delivery dominates, its mobile interaction is better for the owner, and its persistent-host design survives the relevant failure tests. Its narrower published real-AI recovery evidence is a reason to test it—not a reason to skip the trial. [Recovery evidence](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.7/docs/research/persistent-acp-chat-hosts.md).

## Three valuable reusable components

### Official Codex integration

**Take:** App Server’s protocol and generated schemas instead of writing a terminal scraper or another Codex adapter.

**Exact locations:**

- [`openai/codex/codex-rs/app-server`](https://github.com/openai/codex/tree/rust-v0.165.0/codex-rs/app-server)
- [Official protocol documentation](https://developers.openai.com/codex/app-server)

It supplies provider-native authentication, thread history, approval events, interruption and streaming. Prefer a local stdio integration initially; do not expose an unauthenticated WebSocket listener, and do not mistake direct process/filesystem-control methods for sandboxed agent actions. **Evidence: Docs.** [App Server documentation](https://developers.openai.com/codex/app-server).

**Likely saving:** substantial adapter and session-control work. **Not supplied:** your acceptance contract, publication policy or exact subscription reserve.

### OpenHands typed agent interface

**Take:** the SDK/Agent Server and typed client boundary where it saves maintaining your own event, ACP and confirmation plumbing.

**Exact inspected locations:**

- [`clients/typescript/src/client/acp-client.ts`](https://github.com/OpenHands/software-agent-sdk/blob/v1.58.2/clients/typescript/src/client/acp-client.ts)
- [`clients/typescript/src/security/confirmation-policy.ts`](https://github.com/OpenHands/software-agent-sdk/blob/v1.58.2/clients/typescript/src/security/confirmation-policy.ts)
- [`tests/sdk/security/test_confirmation_policy.py`](https://github.com/OpenHands/software-agent-sdk/blob/v1.58.2/tests/sdk/security/test_confirmation_policy.py)
- [`tests/sdk/agent/test_acp_contracts.py`](https://github.com/OpenHands/software-agent-sdk/blob/v1.58.2/tests/sdk/agent/test_acp_contracts.py)

**Evidence: Source/tests.** These are reusable protocol and confirmation components, not proof that the owner’s business approvals are automatically enforced.

**Likely saving:** substantial generic integration work if multiple agents remain necessary. **Cost:** accepting the SDK/server compatibility boundary and running its regression suite.

### HAPI remote supervision

**Take:** a separately deployed phone-control application rather than building mobile chat, approval cards and session attachment from scratch.

**Exact locations:**

- [`tiann/hapi@v0.31.3`](https://github.com/tiann/hapi/tree/v0.31.3)
- [`cli/src/claude`](https://github.com/tiann/hapi/tree/v0.31.3/cli/src/claude)
- [`cli/src/codex`](https://github.com/tiann/hapi/tree/v0.31.3/cli/src/codex)
- [`android/app/src`](https://github.com/tiann/hapi/tree/v0.31.3/android/app/src)

HAPI documents official-agent remote sessions, native clients, a web/PWA interface and approvals; its latest inspected release is **0.31.3**, dated 27 October. **Evidence: Docs/source, not a demonstrated secure deployment on this PC.** [github](https://github.com/tiann/hapi/releases)

**Likely saving:** substantial phone-interface work. **Cautions:** AGPL obligations, another privileged access surface, and no automatic solution to isolation, allowance reserves or safe publication. Test official remote options before adding it.

## A small, fair trial

### Compare five arms

- Mission Control, using **real** official providers.
- Plain official CLI, with a human following a written checklist.
- Official CLI plus the proposed thin coordinator.
- OpenHands with the selected official-agent configuration.
- Orchestrator with the corresponding provider and containment policy.

Keep provider/model, task inputs, project snapshot, acceptance checks and available tools equivalent. Record any unavoidable difference rather than silently giving one arm more privileges or allowance.

### Use four work packets

| Packet | Deliverable | Independently checked outcome |
|---|---|---|
| Software | Repair a small application defect | Hidden behavioral tests, existing regression suite, no unauthorized dependency changes |
| Website | Implement a small site change | Functional checks, accessibility checks, browser inspection and publication held for approval |
| Research/document | Produce a decision memo from supplied and public sources | Citation verification, factual spot checks, source dates and usable exported document |
| Data | Clean and analyze a messy dataset | Reproducible script, reconciled totals, schema checks and explicit treatment of missing data |

Run each packet once across all five arms: **20 runs**. Repeat the four packets for the best two arms: **8 further runs**. This is enough for a decision-oriented pilot, not enough to claim statistically established reliability.

### Run failure tests first

Use deterministic fixtures and a disposable external-action service before spending substantial real allowance.

| Failure | Required behavior |
|---|---|
| Kill UI or coordinator during a check | Resume without marking the unfinished check as passed |
| Kill the actual provider process | Identify interruption honestly; do not claim the original operation survived |
| External service accepts publication, response is lost | Reconcile by operation ID; no blind duplicate publication |
| Read a sibling project, home secret or Windows-mounted canary | Access denied—not merely a warning in the prompt |
| Change or delete acceptance checks | Completion blocked or manifest change requires owner approval |
| Deny publication from the phone | No publication through an alternate shell/API path |
| Missing/stale allowance observation | No new work starts |
| Worker claims another model reviewed the result | Report uses recorded actor/session evidence, not the worker’s assertion |
| Restart with a pending approval | The same action remains pending; approval does not broaden |
| Interrupt or switch to planning | No queued message silently restarts execution |

For the allowance test, use injected observations to exercise thresholds, then one low-cost real-account check to validate observation/authentication. Do **not** exhaust a subscription to “prove” reserve handling.

### Measure owner value

Record:

- Acceptance checks passed.
- Material errors discovered after claimed completion.
- Unauthorized actions or isolation failures.
- Duplicate or unreconciled external actions.
- CEO minutes spent understanding and approving.
- Technical rescue minutes.
- Time to useful output.
- Real subscription consumption and any API/credit charges.
- Accuracy of the final report and worker/reviewer attribution.

**Reject any arm with an unauthorized external action, secret escape, fabricated check result or unsafe duplicate action**, regardless of speed. Among the remaining arms, prefer the least complicated one that materially reduces owner and operator effort.

## Important current defects

Even official CLIs need pinned versions and regression tests. Codex **0.165.0**, released 27 October, reports fixes for queued messages restarting work after interruption/Plan mode, approval-default handling and a marketplace URL-validation gap. Treat these as fixed-in-that-release claims, not allegations that the current release still has the older defects. [Release notes](https://github.com/openai/codex/releases/tag/rust-v0.165.0), [developers.openai](https://developers.openai.com/codex/changelog)

Claude Code **2.1.312**, released 27 October, reports fixes involving resumed-session persistence, large instruction-file overwrites and command-loading failures that could leave `claude -p` without output. These should inform the trial’s regression cases rather than justify a blanket reliability claim. [Release notes](https://github.com/anthropics/claude-code/releases/tag/v2.1.312).

The practical policy should be **pin → test → upgrade**, not “always use latest” or “never upgrade.” Platform upgrades and underlying CLI upgrades need to be tested as separate changes.

## Unknowns that could change this

| Unknown | Evidence needed |
|---|---|
| Actual PC capacity | RAM, CPU, free storage, Docker availability, WSL configuration and sleep/uptime requirements |
| Mission Control’s real quality | Same-task real-provider runs, including failed checks, interrupted work and denied approvals |
| Exact subscription eligibility | Actual plans, organization policies, account billing settings and selected integration route |
| Reserve enforcement | Demonstration across all applicable windows, stale data and concurrent external usage |
| Publication safety | Crash tests showing durable intent, operation IDs and reconciliation before retry |
| Effective isolation | Canary tests covering sibling projects, credential files, `/mnt/c`, network and mounted sockets |
| Reviewer independence | Recorded sessions, provider/model identity, artifact revision and actual review evidence |
| Licence readiness | Completed checks for unresolved repository licences, dependencies, redistribution and hosted-use obligations |
| CEO usability | Owner completes representative approval/reporting tasks without technical coaching |
| Maintenance economics | Several weeks of operator time records, not estimates from installation success |

The recommendation would change toward **OpenHands** if it passes those tests with little custom code and substantially reduces CEO/operator effort. It would change toward **Orchestrator** if its continuity and remote-supervision advantages outweigh the additional containment and workflow work.

It would change toward **keeping a reduced Mission Control** if its existing safety controls pass real-provider tests and competitors require rebuilding the same controls around larger platforms.

**Past investment is not a reason to retain the product. The deciding evidence is whether each remaining piece saves more future work than it costs to migrate, understand, secure and maintain.**
