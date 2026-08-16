# Changelog

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
