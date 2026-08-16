# dsh-action-outbox

Review several side-effecting DeepSeek Harness tool calls as one immutable batch, then commit or discard them.

`dsh-action-outbox` implements an **output-commit boundary** for tools. Staging records the exact tool name and JSON arguments but does not call the target. Review returns a SHA-256 digest. Commit accepts only that exact digest, asks for one batch approval by default, and then sends each target call through the normal DSH tool pipeline in order.

## Why

Worktrees and file checkpoints help coding agents recover local code. They do not retract an issue comment, an email, a deployment, a payment, or another external emission. The Cordis paper behind DeepSeek Harness names two honest responses to that boundary: withhold output until commit, or define domain-specific compensation. This plugin implements the stronger generic option—**withhold until commit**—without pretending unrelated external systems share an atomic transaction.

## Install

Install the tagged release from GitHub:

```sh
dsh plugin --profile web add github:JimchengChina/dsh-action-outbox#v0.1.0
```

Or install from a checkout:

```sh
dsh plugin --profile web add ./dsh-action-outbox
```

The package is a DSH bundle and activates itself through `cordis.patch.yml`.

## Agent workflow

1. `action_outbox_begin({ label })`
2. One or more `action_outbox_stage({ tool, arguments, summary? })`
3. Optionally remove a mistake with `action_outbox_unstage({ action_id })`
4. `action_outbox_review()`
5. Inspect the exact actions and copy the full `digest`
6. `action_outbox_commit({ expected_digest: digest })` or `action_outbox_discard()`

Before commit, discarding guarantees that no staged target action ran. A changed batch gets a changed digest, so a stale approval cannot commit it.

## Configuration

The default permits any visible non-internal tool to be staged, requires approval for commit, and does not force any direct tool through the outbox.

```yaml
- id: action-outbox
  name: dsh-action-outbox
  config:
    include: ['github_*', 'slack_*', 'deploy_*']
    exclude: ['github_get_*', 'github_list_*']
    enforce: ['github_create_*', 'github_update_*', 'slack_send', 'deploy_*']
    requireApproval: true
    rejectDuplicateActions: true
    maxPendingMs: 1800000
    maxActions: 20
    maxArgumentBytes: 65536
    resultPreviewChars: 2000
    approvalPreviewChars: 4000
```

- `include`: wildcard patterns for tools that may be staged.
- `exclude`: wildcard exceptions to both staging and enforcement.
- `enforce`: wildcard patterns that reject direct calls and require the transactional route. Empty by default for compatibility.
- `requireApproval`: ask once for the exact reviewed batch. Without an approval service, commit fails closed.
- `rejectDuplicateActions`: reject repeated target-name/argument pairs that could otherwise duplicate a write. Disable only when repetition is intentional.
- `maxPendingMs`: expire an uncommitted batch after this many milliseconds so old intent cannot receive a fresh approval. The default is 30 minutes; `0` disables expiry.
- `maxActions` / `maxArgumentBytes`: bound retained in-memory state.
- `resultPreviewChars` / `approvalPreviewChars`: bound model- and user-facing receipts.

`*` is the only wildcard. Every other regular-expression character is literal.

## Safety semantics

- **No target dispatch while staging.** The stage tool only records a lossless JSON snapshot.
- **TOCTOU protection.** Commit requires the latest full SHA-256 batch digest.
- **Whole-batch preflight.** Target arguments are checked while staging, and commit rejects the entire batch before its first side effect if a target tool was removed, hot-reloaded, or changed identity.
- **Normal controls remain active.** Committed calls re-enter DSH permissions, sandbox, hooks, guards, cancellation, and result observation.
- **Commit authority is shallow.** Only the exact staged target call bypasses an `enforce` rule. Tool calls made by that target are not silently authorized and must pass enforcement themselves.
- **Ordered and fail-stop.** Actions run sequentially; the first failure blocks the outbox and no later action runs.
- **Correlatable receipts.** Every dispatched action records its deterministic nested call id, start/end timestamps, duration, and structured DSH error identity when available.
- **No automatic retry.** An external timeout can be ambiguous. Retrying automatically could duplicate a write.
- **No false rollback promise.** Earlier successful actions survive a later failure. Inspect the receipt, reconcile externally, then discard the blocked outbox.
- **Lifecycle-safe pending state.** The queue is deliberately in memory. Plugin unload, restart, or crash loses pending intent but cannot emit it.
- **Bounded approval lifetime.** Open batches expire after 30 minutes by default. Expiry clears review state and performs no target dispatch.

## Limitations

- This is not a distributed transaction across tools or services.
- The plugin cannot undo an action after its target has reported success.
- Existing target-specific approval policies may still ask again during commit; the batch approval does not weaken an underlying tool owner's policy.
- Staged arguments appear in the tool-call/session history; do not place secrets in tool arguments unless the original tool contract already permits that exposure.
- Enforcement governs calls routed through the DSH tool registry. It is not a sandbox against malicious in-process plugins.
- Read tools whose outputs are needed for later planning should be called normally, not staged.

See [the research note](docs/research.md) for the feature comparison, duplicate scan, and paper-derived design rationale.

## Development

```sh
pnpm install
pnpm verify
```

MIT
