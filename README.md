# dsh-action-outbox

Durable **Batch Review Inbox** for DeepSeek Harness tool side effects: stage exact calls, inspect or edit their complete canonical JSON, then approve one immutable batch.

Staging never calls the target. Review re-resolves live policy, tool identity, schema, and arguments, then returns a SHA-256 digest plus a single-use approval nonce. Commit accepts only that pair and dispatches each action through the normal DSH tool pipeline in order.

## Why

Worktrees and file checkpoints can recover local code. They cannot retract an issue comment, email, deployment, payment, or other external emission. The Cordis paper behind DeepSeek Harness names two honest responses to this boundary: withhold output until commit, or define domain-specific compensation. This plugin implements the stronger generic option—**withhold until commit**—without pretending unrelated external systems share an atomic transaction.

## What v0.3 adds

- A DSH-native Batch Review Inbox in the Web sidebar, with complete arguments, per-action byte counts, tool source, tool fingerprint, action hash, copy, and download.
- `action_outbox_replace` for editing a staged tool, arguments, or summary. Any edit invalidates the old digest, nonce, review, and approval.
- Fail-closed long-review handling. A truncated approval card cannot authorize commit by itself; the complete Inbox view must be explicitly acknowledged first.
- Durable pending batches in a `0600` state file. Restarted drafts become `needs_reapproval`, clear old approval state, and must pass current policy/tool/schema checks again.
- Crash-safe commit recovery. A process loss during commit becomes `recovery_required`; any action without a durable success receipt is `ambiguous` and is never retried automatically.
- A built-in **Copy safe demo prompt** onboarding path, plus an active/history split that keeps expired batches out of the pending badge without deleting their evidence.

## Install

Install a tagged GitHub release:

```sh
dsh plugin --profile web add github:JimchengChina/dsh-action-outbox#v0.3.0
```

Or install from a checkout:

```sh
dsh plugin --profile web add ./dsh-action-outbox
```

The package is a DSH bundle and activates itself through `cordis.patch.yml`. Its browser half contributes only to the official `sidebar.footer.action` and `shell.overlay` slots.

For a first run, open **Outbox** and click **Copy safe demo prompt**, then paste it into a new DSH chat. The prompt stages one no-clobber file write under `/private/tmp`, stops after Review, and makes no network request. Expired batches are hidden from the pending count; use **Show expired history** to inspect or discard them.

## Agent workflow

1. `action_outbox_begin({ label })`
2. One or more `action_outbox_stage({ tool, arguments, summary? })`
3. Optionally call `action_outbox_unstage({ action_id })` or `action_outbox_replace({ action_id, tool?, arguments?, summary? })`
4. `action_outbox_review()`
5. Inspect the complete batch in Batch Review Inbox. If the approval preview is truncated, acknowledge the full view there.
6. After an Inbox edit, click **Run fresh review**. When the batch becomes reviewed, the review button is replaced by **Next: copy exact commit prompt**. Use it and paste the result into chat; an Inbox-only review is not added to chat history.
7. `action_outbox_commit({ expected_digest: digest, approval_nonce })` or `action_outbox_discard()`

Do not tell the agent only to “use the latest review” after reviewing in Inbox. The latest review visible to the model may still be an older `action_outbox_review` tool result from chat history. Either paste the exact Inbox commit prompt, or ask the agent to call `action_outbox_review` and immediately commit the credentials returned by that tool call.

Before commit starts, discard guarantees that no staged target action ran. Every mutation produces a different authorization state, even if a caller retains an earlier digest or nonce.

## Restart protocol

```text
open -> reviewed -> restart -> needs_reapproval
                              -> resolve current policy/tool/schema
                              -> new digest + new single-use nonce
                              -> approve -> committing

committing -> crash -> recovery_required
                       -> unresolved calls are ambiguous
                       -> never resume or retry automatically
```

The durable record is bound to the DSH agent/session owner and records the workspace when DSH supplies it. Restart never auto-commits, never reuses an approval nonce, and never treats a stored tool object as current authority.

## Configuration

```yaml
- id: action-outbox
  name: dsh-action-outbox
  config:
    include: ['github_*', 'slack_*', 'deploy_*']
    exclude: ['github_get_*', 'github_list_*']
    enforce: ['github_create_*', 'github_update_*', 'slack_send', 'deploy_*']
    requireApproval: true
    rejectDuplicateActions: true
    persistPending: true
    stateFile: ''
    maxPendingMs: 1800000
    maxActions: 20
    maxArgumentBytes: 65536
    resultPreviewChars: 2000
    approvalPreviewChars: 4000
```

- `include`: wildcard patterns for tools that may be staged.
- `exclude`: wildcard exceptions to both staging and enforcement.
- `enforce`: wildcard patterns that reject direct calls and require the outbox route. Empty by default for compatibility.
- `requireApproval`: ask once for the exact reviewed digest/nonce. Without an approval service, commit fails closed.
- `rejectDuplicateActions`: reject repeated target-name/argument pairs. Replacement is checked too.
- `persistPending`: persist bounded drafts and recovery receipts. Enabled by default.
- `stateFile`: optional absolute or relative override. Empty uses `$DSH_HOME/action-outbox/state.json`, or `~/.dsh/action-outbox/state.json` when `DSH_HOME` is unset.
- `maxPendingMs`: expire an uncommitted batch after this many milliseconds; `0` disables expiry.
- `maxActions` / `maxArgumentBytes`: bound durable state.
- `resultPreviewChars`: bound model-facing result receipts.
- `approvalPreviewChars`: compact approval-card limit. If exceeded, commit requires full Inbox acknowledgement. A headless/TUI deployment without the Inbox must raise this limit enough to show the full review or it will correctly fail closed.

`*` is the only wildcard. Every other regular-expression character is literal.

## Safety semantics

- **Zero target dispatch while staging or editing.** These operations only update bounded local state.
- **Complete review visibility.** The Inbox retains full canonical JSON. Compact cards clearly report truncation and cannot be the sole approval surface.
- **TOCTOU protection.** Digest, single-use nonce, live tool object identity, structural tool fingerprint, schema, and policy are checked at their relevant boundaries.
- **Mutation revocation.** Stage, unstage, and replace clear every earlier review, acknowledgement, and nonce.
- **Restart reauthorization.** Pending drafts restore only as `needs_reapproval` and receive a new nonce after live preflight.
- **Persist-before-dispatch.** The `committing` transition is durably recorded before the first external call. Success receipts are recorded after each settled action.
- **Normal controls remain active.** Committed calls re-enter DSH permissions, sandbox, hooks, guards, cancellation, and result observation.
- **Shallow authority.** Only the exact staged direct call bypasses an `enforce` rule. Descendant calls receive no inherited authorization.
- **Ordered and fail-stop.** The first failure blocks later actions. No external failure or ambiguous recovery is retried automatically.
- **No false rollback promise.** Earlier successful actions survive a later failure. Generic compensation is not invented.

## Limitations

- This is not a distributed transaction across tools or services.
- The plugin cannot generically undo a reported success or determine whether a timed-out external system applied a write.
- Batch approval does not weaken a target tool owner's own approval policy, so commit can still prompt again.
- Arguments already appear in DSH tool/session history and, with persistence enabled, in a local `0600` state file. Do not stage secrets the original tool contract should not expose.
- The tool fingerprint covers the declared name, descriptions, schemas, and timeout. It is a drift detector, not a signature over plugin implementation code or provenance.
- The Inbox inherits the DSH Web access boundary. It does not add independent multi-user authentication.
- Enforcement covers DSH registry calls; it is not a sandbox against malicious in-process code.
- Read tools whose output is needed for planning should be called normally rather than staged.

See [the research note](docs/research.md) for the comparison, duplicate scan, and paper-derived design. See [the threat model](SECURITY.md) before deploying on a shared host.

## Development

```sh
pnpm install
pnpm verify
```

`pnpm build` produces the DSH module-loader artifact at `lib/client.js`; the raw `client.js` file is browser-source input and is not served directly.

MIT
