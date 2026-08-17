# Research note: why an action outbox

Research date: 2026-08-18. Product capabilities and repository inventories are time-sensitive; links below are the primary sources checked on that date.

## v0.3 implementation review

The second implementation audit focused on the gap between a cryptographically complete digest and what a person can actually see in a bounded approval component. A digest is not meaningful consent when the UI silently omits part of the covered payload. v0.3 therefore separates two surfaces:

- the compact DSH approval card, which either contains the complete review or says exactly that it is truncated;
- Batch Review Inbox, which always exposes every canonical argument plus its byte count, live-registry source, tool fingerprint, and independent action hash.

If the compact surface is truncated, commit remains locked until the complete view is explicitly acknowledged. That acknowledgement is bound to the final digest and a single-use nonce; any edit invalidates all three. The browser contribution uses the official additive [`sidebar.footer.action`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/src/client/contract/slots.ts) and [`shell.overlay`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/src/client/index.ts) seats instead of replacing shipped UI.

v0.3 also revisits the earlier rejection of persistence. Persisting a queue is safe only if restart is treated as a revocation boundary, not a continuation point:

1. an ordinary stored draft restores as `needs_reapproval` with no review or nonce;
2. current policy, tool fingerprint/object identity, schema, TTL, and arguments are checked again;
3. a new nonce is generated only after the fresh review;
4. `committing` is persisted before external dispatch;
5. a crash during commit restores as `recovery_required`, and unresolved calls become `ambiguous` rather than retryable.

This gives useful draft durability without making an unsafe exactly-once claim about arbitrary external systems.

## Follow-up implementation review

The first public implementation was re-audited against the current DSH `ToolDefinition` and execution pipeline, the MCP maintainers' [tool-annotation risk vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/), and OpenAI's guidance on [approval as resumable state](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals) and [approval for remote MCP actions](https://developers.openai.com/api/docs/guides/tools-connectors-mcp). That review produced eight behavior changes before the v0.2 release:

1. A digest returned by staging is no longer enough; commit requires a later explicit review of the final batch.
2. Review performs the same live tool-identity and schema preflight as commit.
3. Commit authority is shallow and cannot authorize unlisted descendant tool calls.
4. Exact duplicate target-name/argument pairs are rejected by default.
5. Individual staged actions can be removed without reusing their ids.
6. Open batches expire after 30 minutes by default, invalidating stale review state without dispatch.
7. Receipts retain deterministic nested call ids, timing, and structured DSH error identity.
8. DSH-native call/result presentation metadata gives clients a concise card; v0.3 adds a separate authoritative full-review surface when that card cannot fit the complete batch.

MCP annotations remain hints rather than enforcement, and DSH does not currently expose that vocabulary on `ToolDefinition`. The plugin therefore uses pessimistic explicit policy patterns and deterministic guards instead of inferring safety from tool names or untrusted metadata.

## The category mistake to avoid

DeepSeek Harness, Claude Code, Codex, CCCC, NeMo Agent Toolkit, Gemini Enterprise Agent Platform, and Amazon Bedrock AgentCore overlap, but they do not occupy one layer.

| System | Primary layer | What it owns |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Open-source agent runtime and composition kernel | Agent loop, tools, sessions, model adapters, policies, UI hosts, plugins, lifecycle/HMR |
| [Claude Code](https://code.claude.com/docs/en/features-overview) | Coding-agent product and local/remote harness | Coding UX, tools, checkpoints, hooks, subagents/teams, worktrees, plugins |
| [Codex](https://developers.openai.com/codex/) | Coding-agent product and execution service | Local/cloud tasks, isolated worktrees, review, skills/plugins, automations and managed execution |
| [CCCC](https://github.com/ChesterRa/cccc) | External multi-runtime coordinator | Durable group communication, delivery/read state, remote/mobile operations across Claude Code, Codex and other runtimes |
| [NVIDIA NeMo Agent Toolkit](https://docs.nvidia.com/nemo/agent-toolkit/latest/) | Framework-agnostic Python development/optimization toolkit | Reusable workflows, profiling, observability, evaluation, MCP/A2A and framework adapters |
| [Gemini Enterprise Agent Platform](https://docs.cloud.google.com/gemini-enterprise-agent-platform/overview) | Managed enterprise agent lifecycle platform | Build, runtime, fleet governance, identity/gateway, data/model integration and optimization |
| [Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) | Modular managed production infrastructure | Harness/runtime, identity, gateway, policy, browser/code execution, memory and observability |

CCCC coordinates already-running coding agents; it is closer to a durable team bus/control plane than an agent harness. NeMo is a library that can wrap several frameworks. Gemini and AgentCore own cloud deployment and enterprise governance. DSH is unusual because its Cordis substrate makes the local runtime itself a hot-composable plugin graph.

## DSH versus Claude Code and Codex

| Capability | Claude Code / Codex | DSH status | Plugin opportunity? |
|---|---|---|---|
| Isolated parallel work | Worktrees and parallel tasks/agents | Core support plus several community worktree/task-swarm plugins | No: duplicated |
| Rewind/checkpoints | Claude checkpoints; isolated Codex worktrees and Git history | Multiple checkpoint/rewind plugins | No: duplicated |
| Deterministic lifecycle hooks | Claude hooks; Codex hooks/automations/plugin capabilities | Native waterfalls/guards plus Claude/Codex hook bridges | No: duplicated |
| Subagents and monitoring | Both products support delegated/parallel agents | Core subagent providers plus monitors, DAGs and office UIs | No: duplicated |
| Review before applying code | Review/diff/approval flows | Auto-review, review-loop, proof and change-review plugins | No: duplicated |
| Per-call permissions | Approval/sandbox policies | Core pre-execute, monotonic guards, sandbox and permission plugins | Useful, but already covered |
| Review and edit a *batch of external writes before any is emitted* | Product UX contains approval/review primitives, but not a generic durable cross-tool transaction | Several adjacent approval plugins exist; no DSH-native exact batch proposal-to-commit protocol was found | **Yes, with a narrower differentiator** |

The decisive gap is not another way to ask “allow this one call?” It is the ability to formulate a multi-action plan, inspect the exact batch, and emit nothing until the batch is accepted.

## Duplicate and adjacent-product scan

The raw [`dsh-plugin` topic](https://github.com/topics/dsh-plugin) reported 6,568 repositories on 2026-08-18 and visibly included unrelated projects. It is therefore a noisy discovery feed, not a trustworthy plugin registry. The scan used the curated [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) catalog, direct repositories, and searches for approval, permission, transaction, outbox, staged action, deferred write, preview/apply, and batch review concepts.

| Project | What overlaps | Decisive difference from Action Outbox |
|---|---|---|
| [`dsh-permission-rules`](https://github.com/PerryLink/dsh-permission-rules) | Deterministic ordered `allow` / `deny` / `ask`, argument/path matching, audit, network rules | Decides each call against operator policy; it does not stage one immutable multi-call proposal. It is the preferred complementary policy layer, not something to reimplement. |
| [`dsh-approval-gate`](https://github.com/moon09300731/dsh-approval-gate) | Reduces approval fatigue with deterministic checks plus a Flash SAFE/RISKY classifier | Swaps or automates the approver for a boundary request; it does not bind an editable batch to a digest and single-use commit credential. |
| [`dsh-permgate`](https://github.com/MrWeiCodes/dsh-permgate) | Rich per-call approval UI, categories, rules, rejection feedback, inline file diff | Closest DSH UI overlap, but its unit is a current tool call or permission escalation, not a zero-dispatch batch transaction. |
| [`dsh-turn-approval`](https://github.com/arrow949/dsh-turn-approval) | Time-scoped authority and restart fail-closed behavior | Authorizes later calls of the same escalation class for one turn; Action Outbox authorizes only the exact reviewed arguments and consumes the nonce once. |
| [LangGraph Agent Inbox](https://github.com/langchain-ai/agent-inbox) | Human inbox with accept/edit/respond/ignore for an interrupt | LangGraph deployment UI for interrupt objects; not a DSH host-enforced ordered batch with canonical digest, live identity recheck, and commit receipts. |
| [Impri](https://github.com/sekera-radim/impri) | Self-hosted approval inbox, MCP/REST, searchable actions, bulk approve/reject (up to 50), result reporting | The most direct adjacent product, but its documented bulk operation is a decision over independent actions. Action Outbox treats the entire ordered set and exact arguments as one mutation-revoking commit unit inside DSH. |
| [AgentClick](https://github.com/agentlayer-io/AgentClick) | Browser review/edit UI for actions, plans, diffs, email and trajectories | A skill/HTTP integration that depends on an agent routing proposals through it; Action Outbox also installs a DSH `pre-execute` enforcement seam. |
| [Clawvisor](https://github.com/clawvisor/clawvisor) | Gateway-held credentials, purpose scopes, TTL, scope expansion and per-request fallback | Governs service capabilities over a task lifetime. It is stronger for credential custody and broad authorization, while Action Outbox is stricter about the bytes in one final batch. |

The updated conclusion is intentionally narrower than “nothing similar exists.” Approval gates, permission rules, editable inboxes, bulk decisions, and purpose scopes all exist. No reviewed project documented the same complete DSH-native protocol: **zero-dispatch staging → full canonical batch review → edit/restart revocation → live preflight → digest + single-use nonce → ordered fail-stop dispatch through the normal DSH tool pipeline**. Private, untagged, or undocumented implementations may still exist.

## What the Cordis paper contributes

[A Programming Paradigm for Spatiotemporal Composability](https://github.com/cordiverse/paper) defines two complementary properties:

- **Temporal composability:** removing a component reverses its context-mediated effects in LIFO order.
- **Spatial composability:** components declare coeffects/dependencies and react to providers appearing, disappearing, or changing identity.

The important limit appears in its system-boundary discussion: effects inside the mediated context can be reversed, but an external emission cannot be generically “un-sent.” The paper gives two responses: withhold output until state is committed (the output-commit problem), or perform a domain-specific compensating action. Compensation is weaker because a refund, deletion, or follow-up message is not observationally identical to the original action never happening.

That leads directly to this plugin's semantics:

1. Pending actions are bounded component state. v0.3 may persist their data, but unload/restart revokes all review and approval authority before they can re-enter the live graph.
2. Staging performs no target dispatch, so discard is a real zero-effect operation.
3. Commit is an explicit temporal boundary guarded by an immutable batch digest.
4. After commit begins, the plugin reports partial success honestly and does not claim general rollback.
5. In-process guards are capability mediation, not a security sandbox against malicious plugins—another limit stated by the paper.

The paper is an active 2026 preprint and its Koishi case study is evidence of adoption and feasibility, not a controlled productivity or overhead study. Its formal model is therefore most valuable here as a design discipline, not as proof that this plugin makes external systems transactional.

## Frontier-lab implementation signals

Official engineering material was given more weight than marketing pages or social commentary. The common direction is layered control: deterministic boundaries, containment, explicit approval for consequential actions, durable state, and observable receipts. The labs differ mostly in where they put those layers.

| Source | Useful signal for this plugin | Consequence |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and its [Hermes integration warning](https://api-docs.deepseek.com/quick_start/agent_integrations/hermes) | DSH offers the lifecycle and UI seams, while explicitly warning that third-party agent integrations carry their own security risk | Keep enforcement inside the DSH tool pipeline and avoid claiming that plugin composition is a security boundary against malicious code. |
| OpenAI on [agent approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals), [MCP tools](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [Codex safety](https://openai.com/index/running-codex-safely/), and [prompt-injection resistance](https://openai.com/index/designing-agents-to-resist-prompt-injection/) | Approval is a resumable interruption bound to exact action details; sandbox/network policy and telemetry remain independent layers; source-to-sink combinations matter | Preserve exact reviewed arguments across delayed approval, fail closed on drift, and add composition-risk and audit integrations rather than presenting the outbox as a sandbox. |
| Anthropic on [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing), [agent containment](https://www.anthropic.com/engineering/how-we-contain-claude), [auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode), and [managed agents](https://www.anthropic.com/engineering/managed-agents) | Sandboxing sharply reduces approval fatigue; credentials should live outside the agent sandbox; durable event logs and recovery belong outside the transient agent process; model screening has measurable false negatives | Do not solve every safe read with another modal. Keep credentials out of staged payloads, retain restart-safe intent/receipts, and reserve human review for final effects. |
| Z.ai's [safety confirmations](https://zcode.z.ai/en/docs/safety-confirm) and [agent model](https://zcode.z.ai/en/docs/agents) | The product shows exact commands/files/tools, pauses the task, retains pending confirmation, and distinguishes one-time from persistent permission | Continue making the exact payload inspectable and the approval one-time; do not turn a batch nonce into broad session permission. |
| Kimi Code's [tool approval reference](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/tools.md) and [Agent SDK](https://github.com/MoonshotAI/kimi-agent-sdk) | Built-in and MCP tools share one approval protocol; read-only and write-like tools have different defaults; SDK callers can approve once, for a session, or reject | Interoperate with DSH's normal approval service rather than creating a second hidden execution channel, while keeping Action Outbox authority narrower than session approval. |

Public channels of founders and core researchers were also searched. No current first-party personal post from DeepSeek, OpenAI, Anthropic, Z.ai/GLM, or Moonshot/Kimi was found that specified a more relevant low-level batch-approval protocol than the official engineering sources above. They are therefore not cited merely to pad the comparison; this is a source-quality decision, not evidence that such commentary does not exist.

## Related research and useful design signals

- [SWE-agent](https://arxiv.org/abs/2405.15793) shows that the agent-computer interface materially affects agent behavior and performance. Harness UX is not incidental glue; a first-class stage/review/commit interface can change what the model reliably does.
- [AgentSpec](https://arxiv.org/abs/2503.18666) supports deterministic, interpretable runtime rules around agent actions. Its results favor code-enforced trigger/check/enforce paths over relying only on model instructions. This motivated the optional `enforce` guard.
- [AgentDojo](https://arxiv.org/abs/2406.13352) demonstrates that untrusted tool output can redirect later actions through prompt injection. Batch review creates a useful human-visible boundary before several writes, although it is not by itself a prompt-injection defense.
- [ToolEmu](https://arxiv.org/abs/2309.15817) finds severe long-tail risks in tool-using agents and motivates testing dangerous actions in emulated environments. It supports adding a future dry-run adapter, while the current plugin deliberately does not fabricate target results.
- [Atomix](https://arxiv.org/abs/2602.14849) models progress-aware transactions over tool reads and effects, including sealing, per-resource progress frontiers, and distinctions among bufferable, reversible, and irreversible effects. It supports a future adapter layer with explicit resource keys, while also warning against pretending arbitrary APIs share one generic transaction model.
- [Verified Tool Calls](https://arxiv.org/abs/2608.02645) uses postcondition verification and idempotency keys to reduce duplicated or lost side effects when a tool result is uncertain. This supports verify-before-retry and reconciliation adapters; it does not justify retrying an unregistered tool.
- [Before Tool Call / OAP](https://arxiv.org/abs/2603.20953) proposes deterministic pre-action authorization, declarative policy, and signed audit. It reinforces the placement of enforcement before dispatch, but as a single-author preprint it is a design signal rather than established evidence.
- [AIOS](https://arxiv.org/abs/2403.16971) treats scheduling, tools, memory, storage and access control as kernel responsibilities. DSH's tool registry is the correct enforcement seam; individual tool implementations should not each reinvent batching.
- [SafeHarness](https://arxiv.org/abs/2604.13630) argues for lifecycle-integrated filtering, causal verification, privilege-separated tool control and rollback/degradation. The paper is a recent preprint, but its architecture supports keeping approval and enforcement in the execution lifecycle.
- [MOSS](https://arxiv.org/abs/2605.22794) and [Self-Evolving Agent Harnesses](https://arxiv.org/abs/2607.13683) separate proposing changes from deterministic evaluation/promotion. Their gated-promotion pattern is structurally similar to stage/review/commit and reinforces that the commit verdict should belong to deterministic runtime code.

These papers do not establish that one generic outbox makes an agent safe. Together they support five narrower engineering choices: explicit ACI, deterministic guards, lifecycle placement, pre-commit evaluation, and honest rollback boundaries.

## Evaluation datasets and harnesses

- NVIDIA's [Nemotron Agentic Indirect Prompt Injection dataset](https://huggingface.co/datasets/nvidia/Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1) covers nine agent domains and chains untrusted read results into unauthorized actions or exfiltration. It is useful for measuring whether a dangerous final batch still reaches commit.
- Scale AI's [ASPI dataset](https://huggingface.co/datasets/ScaleAI/aspi) places injections inside the agent's clarification state across AgentDojo environments. It is useful for testing whether an apparently benign follow-up silently mutates the reviewed proposal.
- [SafeClawBench](https://huggingface.co/datasets/sairights/safeclawbench) separates semantic failure, evidence in the audit trail, and actually observed sandbox harm. Its published scores should be treated as dataset-card claims, but that three-endpoint evaluation design is valuable for this plugin.

The datasets are evaluation inputs, not proof of safety and not default training data. Tests should preserve both security and usability metrics so that “block everything” cannot look successful.

## Chosen contract

```text
begin -> stage/edit N calls -> review + digest + nonce -> approve -> ordered commit
                                           \\-> discard (zero target calls)

review -> compact preview complete -> normal DSH approval
       -> compact preview truncated -> full Inbox acknowledgement -> DSH approval

reviewed -> restart -> needs_reapproval -> live preflight -> new review + nonce

ordered commit -> success -> close
               -> first failure -> block, preserve receipt, never auto-retry
               -> process crash -> recovery_required, unresolved effects ambiguous
```

The commit tool dispatches each target as a nested DSH call. This preserves the visible agent scope and re-enters pre-execute policy, guards, approval, sandbox, hooks, cancellation and final result observation. The optional `enforce` exception is deliberately shallow: it matches only the exact direct target name and call id beneath the active commit. Calls made by a composite target are not part of the reviewed batch and receive no inherited authorization.

## Rejected alternatives

- **Transparent interception of arbitrary tool calls:** DSH validates wrapper-authored success values against each target's output schema. A generic “staged” success would violate tool contracts; returning an error is misleading. The explicit stage tool is honest and schema-safe.
- **Automatically stage every write:** tool names and semantics are deployment-specific, and later reasoning may require a write result. Enforcement is opt-in through wildcard patterns.
- **Automatic retry after a failed/timeout action:** the remote effect may have happened even when the local result failed. Retrying can duplicate non-idempotent writes.
- **Generic compensation:** deleting a message, refunding a payment, or rolling back a deployment needs tool-specific semantics and authorization. A future extension can support registered compensators, but the base plugin must not invent them.
- **Persistence that resumes approval or dispatch:** rejected. Durability is limited to intent and receipts. Restart clears authorization, re-resolves live identity/schema/policy, issues a new nonce, and never resumes a commit.
- **Silently truncated approval text:** rejected. The digest may cover bytes a compact component cannot show, so truncation creates a full-review acknowledgement gate.
- **Approval nonce without mutation revocation:** rejected. Nonces are single-use, tied to the current digest, absent after restart, and cleared by stage/unstage/replace.

## Evaluation criteria

The test suite verifies:

- staging produces zero target side effects;
- canonical digest is stable across JSON key order and rejects stale commits;
- target argument validation and tool-identity drift fail before the first committed side effect;
- configured tools cannot bypass the outbox through direct calls;
- committed actions preserve order and re-enter the DSH tool pipeline;
- approval fails closed when no approval service exists;
- first failure blocks the batch, preserves a partial receipt, skips later actions, and cannot be retried accidentally;
- replacement invalidates stale digest/nonce/acknowledgement and still rejects duplicate writes;
- pending restart requires reapproval and never restores an approval nonce;
- a crash after commit begins creates a non-retryable `recovery_required` state with ambiguous unresolved actions;
- the state file is atomic, owner/workspace metadata survives, and staged arguments remain complete;
- memory and preview bounds are enforced, and truncated previews identify themselves as non-authoritative.

The next formal evaluation should report, rather than merely assert:

- **zero staging dispatch:** external target-call count remains exactly 0 before commit;
- **revocation integrity:** stale, edited, restarted, and replayed approval credentials are rejected in 100% of deterministic test cases;
- **attack outcome:** dangerous batch-commit rate under indirect prompt injection, with semantic failure, audit evidence, and observed side effect reported separately;
- **usability cost:** normal-task false-block rate, approval count, and time-to-review;
- **runtime stress:** DSH hot reload, process crash, schema/tool-identity drift, and concurrent-agent conflicts.

## Final prioritization after v0.3

The P0 usability and restart-safety layer is now complete: full canonical review, edit-invalidates-review, one-use commit credentials, durable drafts with restart revocation, crash ambiguity, an active/history split for expired batches, and a copyable no-network/no-clobber first-run demo.

The strongest remaining work is deliberately complementary rather than another approval UI:

1. **P1 — composition-risk facts:** consume trusted, operator-supplied metadata such as reads-private-data, returns-untrusted-content, external-communication, destructive/idempotent, and resource key. Detect risky combinations across the whole batch. Prefer interoperability with [`dsh-permission-rules`](https://github.com/PerryLink/dsh-permission-rules) over inventing a second policy language; never infer guarantees from tool names or untrusted MCP annotations.
2. **P1 — approval identity and durable audit:** record approver identity when DSH exposes it, otherwise honestly store `unknown`; distinguish human/policy/model sources; hash-chain default-redacted events; export JSONL/OpenTelemetry with review digest, nonce lifecycle, tool identity/version, call id, result, and network-policy decision.
3. **P2 — registered transaction adapters:** optionally declare idempotency keys, dry-run/preflight, resource keys/leases, postcondition reconciliation, and explicit compensators. Unregistered tools retain today's safe default: no automatic retry, no invented rollback, and ambiguous results remain ambiguous.
4. **P2 — containment guidance:** document deployment with filesystem/network isolation and credentials held outside the agent process. These are host/operator controls, not features the outbox should misleadingly simulate.

This priority order is also the product boundary: Action Outbox should remain the exact-batch commit layer and compose with policy, sandbox, credential, and observability products instead of absorbing all of them.
