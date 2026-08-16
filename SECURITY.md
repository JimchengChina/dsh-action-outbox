# Security policy and threat model

## Supported versions

Only the latest tagged release receives security fixes. Pin a release tag or commit when installing from GitHub.

## Report a vulnerability

Use GitHub's private security-advisory flow for this repository. Do not include secrets, credentials, or live exploit targets in a public issue. For ordinary correctness bugs that contain no sensitive material, open a normal GitHub issue with a minimal reproduction and the DSH/plugin versions.

## Trust boundary

The plugin is deterministic mediation inside one trusted DSH process. It is not a sandbox against a malicious plugin, tool implementation, model provider, or host administrator. A target tool is trusted to execute the call it declares; the outbox controls when that exact registered definition is dispatched.

The security claims are deliberately narrow:

- staging and unstaging dispatch no target tool;
- only the final explicitly reviewed digest may begin commit;
- review and commit fail if a target definition or schema changed;
- an `enforce` exception covers only the exact direct staged call id and name;
- expiry, discard, cancellation before dispatch, and process loss cannot emit pending actions;
- actions run in order and stop after the first observed failure;
- no failed or timed-out external call is retried automatically.

The plugin does not claim:

- atomic rollback across external systems;
- prevention of side effects hidden inside a target tool implementation;
- trustworthy risk classification based on tool names or third-party metadata;
- secrecy for arguments already present in the DSH tool/session history;
- durable recovery of uncommitted intent after restart;
- certainty about an external effect when a target times out or loses its response.

## Deployment checklist

1. Configure `include` narrowly and `enforce` every known external write tool.
2. Exclude read-only discovery tools so planning can obtain their results normally.
3. Keep `requireApproval`, `rejectDuplicateActions`, and finite `maxPendingMs` enabled.
4. Treat composite target tools as security-sensitive code; their descendant calls do not inherit outbox authorization.
5. Preserve DSH session events and the receipt `call_id` values for investigation.
6. Reconcile ambiguous failures in the external system before discarding the blocked batch.
7. Never stage credentials that the original tool contract would not safely expose.
