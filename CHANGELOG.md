# Changelog

## 0.3.0 — 2026-08-18

- Add a DSH-native Batch Review Inbox with complete canonical JSON, per-action source/size/hash/fingerprint, copy, and download.
- Add `action_outbox_replace`; every edit invalidates the previous digest, review, acknowledgement, and approval nonce.
- Require a fresh single-use nonce alongside the final digest for every commit.
- Fail closed when a compact approval preview is truncated until the complete Inbox view is explicitly acknowledged.
- Persist bounded pending batches in an atomic `0600` state file, bound to the DSH owner/session/workspace metadata available at staging time.
- Restore ordinary drafts as `needs_reapproval` and recheck live policy, identity, schema, TTL, digest, and nonce.
- Restore interrupted commits as `recovery_required`, mark unresolved effects `ambiguous`, and prohibit automatic resume or retry.
- Add restart, crash-boundary, nonce-replay, acknowledgement, replacement, and duplicate-edit tests.
- Ship the Web client as a DSH module-loader bundle instead of raw ESM, with a reproducible `pnpm build`/`prepare` step for local and Git installs.
- Keep the closed Inbox badge synchronized with background tool activity instead of waiting for the panel to be opened.
- Add an exact commit-prompt handoff from Inbox to chat so an edit or fresh review cannot accidentally reuse stale credentials from conversation history.
- Make the Inbox handoff state explicit: unreviewed batches show Fresh Review, reviewed batches show only the next-step exact prompt, and stale-digest errors explain that UI-only reviews are not chat history.
- Add a one-click safe demo prompt for first-run onboarding; it stages a no-clobber `/private/tmp` write and stops before commit.
- Separate expired history from active work so expired batches no longer inflate the pending badge or obscure actionable batches.

## 0.2.0 — 2026-08-16

- Require an explicit review after the final batch mutation.
- Preflight live tool identity and arguments during both review and commit.
- Limit commit authorization to the exact direct staged call.
- Reject accidental duplicate calls by default.
- Add `action_outbox_unstage` with stable, non-reused action ids.
- Expire open batches after 30 minutes by default.
- Add correlatable call ids, timestamps, durations, and structured errors to receipts.
- Add native DSH call/result presentation metadata.
- Test supported Node.js 22.19 and 24 runtimes in CI.

## 0.1.0 — 2026-08-16

- Initial stage, review, digest, approve, ordered commit, and discard workflow.
- Optional direct-call enforcement and whole-batch preflight.
- Fail-stop partial receipts with no automatic retry or false rollback claim.
