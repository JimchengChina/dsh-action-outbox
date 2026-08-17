# Security policy and threat model

## Supported versions

Only the latest tagged release receives security fixes. Pin a release tag or commit when installing from GitHub.

## Report a vulnerability

Use GitHub's private security-advisory flow for this repository. Do not include secrets, credentials, or live exploit targets in a public issue. For ordinary correctness bugs that contain no sensitive material, open a normal GitHub issue with a minimal reproduction and the DSH/plugin versions.

## Trust boundary

The plugin is deterministic mediation inside one trusted DSH process. It is not a sandbox against a malicious plugin, tool implementation, model provider, Web user, or host administrator. A target tool is trusted to execute the call it declares; the outbox controls when that exact registered definition is dispatched. Batch Review Inbox inherits the DSH Web access boundary and exposes the same staged arguments already available to the owning DSH process.

The security claims are deliberately narrow:

- staging, unstaging, replacement, review, acknowledgement, and discard dispatch no target tool;
- only the final explicitly reviewed digest and its single-use nonce may begin commit;
- every batch mutation invalidates review, acknowledgement, digest authority, and nonce;
- review and commit fail if current policy, target identity/fingerprint, or schema changed;
- a truncated compact approval cannot proceed until the complete Inbox representation is acknowledged;
- an `enforce` exception covers only the exact direct staged call id and name;
- expiry, discard, restart recovery, and cancellation before dispatch cannot emit pending actions;
- actions run in order and stop after the first observed failure;
- no failed, timed-out, or crash-ambiguous external call is retried automatically;
- the `committing` transition is persisted before the first external dispatch.

The plugin does not claim:

- atomic rollback across external systems;
- prevention of side effects hidden inside a target tool implementation;
- trustworthy risk classification based on tool names or third-party metadata;
- cryptographic integrity of tool implementation code or provenance from its structural fingerprint;
- secrecy for arguments already present in the DSH tool/session history;
- certainty about an external effect when a target times out or loses its response.

The persistent record contains staged arguments and receipts. The default path is under `$DSH_HOME/action-outbox` or `~/.dsh/action-outbox`; the plugin writes the state file with mode `0600`, refuses a symlink/non-regular state file, uses an exclusive temporary file, fsyncs, and atomically renames. This is local confidentiality against other non-privileged OS users, not encryption against the account owner or host administrator. Protect backups and any custom `stateFile` parent directory accordingly.

On restart, `open` or previously reviewed state becomes `needs_reapproval` and receives no restored nonce. A stored tool fingerprint is compared with the live definition during fresh review. A persisted `committing` state becomes `recovery_required`; actions lacking a durable success/failure receipt become `ambiguous`. That state cannot be reviewed or committed and requires external reconciliation before discard.

## Deployment checklist

1. Configure `include` narrowly and `enforce` every known external write tool.
2. Exclude read-only discovery tools so planning can obtain their results normally.
3. Keep `requireApproval`, `rejectDuplicateActions`, `persistPending`, and finite `maxPendingMs` enabled.
4. Treat composite target tools as security-sensitive code; their descendant calls do not inherit outbox authorization.
5. Preserve DSH session events and the receipt `call_id` values for investigation.
6. Reconcile `blocked`, timed-out, and `recovery_required` actions in the external system before discard.
7. Restrict access to DSH Web and to the configured state file; the Inbox has no separate authentication layer.
8. Never stage credentials that the original tool contract and local persistence policy would not safely expose.
9. On headless clients, size `approvalPreviewChars` to fit the complete review. A truncated review intentionally requires the Web Inbox and otherwise remains blocked.
10. Keep deterministic permission and network controls below the outbox. The outbox binds intent to exact calls; it does not replace a sandbox, egress policy, or a plugin such as `dsh-permission-rules`.
11. Treat “reads private data + consumes untrusted content + can communicate externally” as a batch/session composition risk. Until DSH exposes trusted risk facts, configure these boundaries explicitly rather than inferring them from tool names.
