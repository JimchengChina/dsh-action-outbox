# Research note: why an action outbox

Research date: 2026-08-16. Product capabilities and repository inventories are time-sensitive; links below are the primary sources checked on that date.

## Follow-up implementation review

The first public implementation was re-audited against the current DSH `ToolDefinition` and execution pipeline, the MCP maintainers' [tool-annotation risk vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/), and the OpenAI Agents SDK guidance on [call-scoped approvals](https://github.com/openai/openai-agents-python/blob/main/docs/human_in_the_loop.md) and [tool call ids for side effects](https://github.com/openai/openai-agents-python/blob/main/docs/models/index.md). That review produced eight behavior changes before the v0.2 release:

1. A digest returned by staging is no longer enough; commit requires a later explicit review of the final batch.
2. Review performs the same live tool-identity and schema preflight as commit.
3. Commit authority is shallow and cannot authorize unlisted descendant tool calls.
4. Exact duplicate target-name/argument pairs are rejected by default.
5. Individual staged actions can be removed without reusing their ids.
6. Open batches expire after 30 minutes by default, invalidating stale review state without dispatch.
7. Receipts retain deterministic nested call ids, timing, and structured DSH error identity.
8. DSH-native call/result presentation metadata gives clients a concise card while preserving authoritative review content.

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
| Review a *batch of external writes before any is emitted* | Product UX contains approval/review primitives, but not a generic cross-tool transaction | No matching topic repository or catalog entry found | **Yes** |

The decisive gap is not another way to ask “allow this one call?” It is the ability to formulate a multi-action plan, inspect the exact batch, and emit nothing until the batch is accepted.

## Duplicate scan

The [`dsh-plugin` topic](https://github.com/topics/dsh-plugin) and the community awesome catalog were searched for worktree, checkpoint, rewind, hook, review, approval, transaction, outbox, staged action, deferred write, preview/apply, and batch approval concepts.

Representative existing projects include worktree plugins, checkpoint/rewind plugins, Claude/Codex hook bridges, background-agent monitors, permission rules, automatic reviewers, PR/CI integrations, LSP/code intelligence, previews, plugin clinics and dependency/security guards. Repository searches for `dsh action outbox`, `dsh transactional tools`, `dsh deferred actions`, `dsh batch approval`, and equivalent DeepSeek Harness terms returned no matching plugin repository on 2026-08-16.

That does not prove no private or untagged implementation exists. It does establish that the proposed public package does not duplicate a discoverable topic/catalog project.

## What the Cordis paper contributes

[A Programming Paradigm for Spatiotemporal Composability](https://github.com/cordiverse/paper) defines two complementary properties:

- **Temporal composability:** removing a component reverses its context-mediated effects in LIFO order.
- **Spatial composability:** components declare coeffects/dependencies and react to providers appearing, disappearing, or changing identity.

The important limit appears in its system-boundary discussion: effects inside the mediated context can be reversed, but an external emission cannot be generically “un-sent.” The paper gives two responses: withhold output until state is committed (the output-commit problem), or perform a domain-specific compensating action. Compensation is weaker because a refund, deletion, or follow-up message is not observationally identical to the original action never happening.

That leads directly to this plugin's semantics:

1. Pending actions are ordinary in-memory component state and disappear safely on unload.
2. Staging performs no target dispatch, so discard is a real zero-effect operation.
3. Commit is an explicit temporal boundary guarded by an immutable batch digest.
4. After commit begins, the plugin reports partial success honestly and does not claim general rollback.
5. In-process guards are capability mediation, not a security sandbox against malicious plugins—another limit stated by the paper.

The paper is an active 2026 preprint and its Koishi case study is evidence of adoption and feasibility, not a controlled productivity or overhead study. Its formal model is therefore most valuable here as a design discipline, not as proof that this plugin makes external systems transactional.

## Related research and useful design signals

- [SWE-agent](https://arxiv.org/abs/2405.15793) shows that the agent-computer interface materially affects agent behavior and performance. Harness UX is not incidental glue; a first-class stage/review/commit interface can change what the model reliably does.
- [AgentSpec](https://arxiv.org/abs/2503.18666) supports deterministic, interpretable runtime rules around agent actions. Its results favor code-enforced trigger/check/enforce paths over relying only on model instructions. This motivated the optional `enforce` guard.
- [AgentDojo](https://arxiv.org/abs/2406.13352) demonstrates that untrusted tool output can redirect later actions through prompt injection. Batch review creates a useful human-visible boundary before several writes, although it is not by itself a prompt-injection defense.
- [ToolEmu](https://arxiv.org/abs/2309.15817) finds severe long-tail risks in tool-using agents and motivates testing dangerous actions in emulated environments. It supports adding a future dry-run adapter, while the current plugin deliberately does not fabricate target results.
- [AIOS](https://arxiv.org/abs/2403.16971) treats scheduling, tools, memory, storage and access control as kernel responsibilities. DSH's tool registry is the correct enforcement seam; individual tool implementations should not each reinvent batching.
- [SafeHarness](https://arxiv.org/abs/2604.13630) argues for lifecycle-integrated filtering, causal verification, privilege-separated tool control and rollback/degradation. The paper is a recent preprint, but its architecture supports keeping approval and enforcement in the execution lifecycle.
- [MOSS](https://arxiv.org/abs/2605.22794) and [Self-Evolving Agent Harnesses](https://arxiv.org/abs/2607.13683) separate proposing changes from deterministic evaluation/promotion. Their gated-promotion pattern is structurally similar to stage/review/commit and reinforces that the commit verdict should belong to deterministic runtime code.

These papers do not establish that one generic outbox makes an agent safe. Together they support five narrower engineering choices: explicit ACI, deterministic guards, lifecycle placement, pre-commit evaluation, and honest rollback boundaries.

## Chosen contract

```text
begin -> stage N exact calls -> review + digest -> approve -> ordered commit
                                      \\-> discard (zero target calls)

ordered commit -> success -> close
               -> first failure -> block, preserve receipt, never auto-retry
```

The commit tool dispatches each target as a nested DSH call. This preserves the visible agent scope and re-enters pre-execute policy, guards, approval, sandbox, hooks, cancellation and final result observation. The optional `enforce` exception is deliberately shallow: it matches only the exact direct target name and call id beneath the active commit. Calls made by a composite target are not part of the reviewed batch and receive no inherited authorization.

## Rejected alternatives

- **Transparent interception of arbitrary tool calls:** DSH validates wrapper-authored success values against each target's output schema. A generic “staged” success would violate tool contracts; returning an error is misleading. The explicit stage tool is honest and schema-safe.
- **Automatically stage every write:** tool names and semantics are deployment-specific, and later reasoning may require a write result. Enforcement is opt-in through wildcard patterns.
- **Automatic retry after a failed/timeout action:** the remote effect may have happened even when the local result failed. Retrying can duplicate non-idempotent writes.
- **Generic compensation:** deleting a message, refunding a payment, or rolling back a deployment needs tool-specific semantics and authorization. A future extension can support registered compensators, but the base plugin must not invent them.
- **Persistent pending queue:** crash recovery would require durable identity, tool-schema/version drift handling, and an explicit re-approval protocol. Losing uncommitted intent is the safer v0.1 behavior.

## Evaluation criteria

The initial test suite verifies:

- staging produces zero target side effects;
- canonical digest is stable across JSON key order and rejects stale commits;
- target argument validation and tool-identity drift fail before the first committed side effect;
- configured tools cannot bypass the outbox through direct calls;
- committed actions preserve order and re-enter the DSH tool pipeline;
- approval fails closed when no approval service exists;
- first failure blocks the batch, preserves a partial receipt, skips later actions, and cannot be retried accidentally;
- memory and preview bounds are enforced.
