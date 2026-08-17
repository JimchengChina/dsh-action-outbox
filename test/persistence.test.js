import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OutboxLedger } from '../lib/outbox.js'
import { JsonStateStore } from '../lib/persistence.js'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-action-outbox-'))
  t.after(() => rmSync(directory, { recursive: true }))
  return new JsonStateStore(join(directory, 'state.json'))
}

test('a pending batch restores as needs_reapproval with its owner binding and full arguments', t => {
  const store = fixture(t)
  const first = new OutboxLedger({ maxActions: 3, maxPendingMs: 0, store })
  first.begin('session-1', 'durable review', {
    owner_id: 'session-1', session_id: 'session-1', workspace: '/workspace/project',
  })
  first.stage('session-1', {
    tool: 'send_message',
    arguments: { channel: 'release', text: '完整正文' },
    definitionFingerprint: 'sha256:tool-v1',
    toolSource: 'test-registry',
  })
  const oldReview = first.review('session-1')
  assert.equal(oldReview.reviewed, true)

  const restored = new OutboxLedger({ maxActions: 3, maxPendingMs: 0, store })
  const inbox = restored.inspect('session-1')
  assert.equal(inbox.phase, 'needs_reapproval')
  assert.equal(inbox.reviewed, false)
  assert.equal(inbox.approval_nonce, null)
  assert.equal(inbox.owner.workspace, '/workspace/project')
  assert.deepEqual(inbox.actions[0].arguments, { channel: 'release', text: '完整正文' })
  assert.equal(inbox.actions[0].canonical_arguments, '{"channel":"release","text":"完整正文"}')
  assert.equal(inbox.actions[0].tool_fingerprint, 'sha256:tool-v1')
  assert.equal(statSync(store.path).mode & 0o777, 0o600)

  const freshReview = restored.review('session-1')
  assert.notEqual(freshReview.approval_nonce, oldReview.approval_nonce)
  assert.equal(restored.beginCommit(
    'session-1', freshReview.digest, oldReview.approval_nonce,
  ).code, 'approval_nonce_mismatch')
  assert.equal(restored.beginCommit(
    'session-1', freshReview.digest, freshReview.approval_nonce,
  ).ok, true)
})

test('a crash during commit restores pending effects as ambiguous and never retries them', t => {
  const store = fixture(t)
  const first = new OutboxLedger({ maxActions: 3, maxPendingMs: 0, store })
  first.begin('session-2', 'crash boundary')
  first.stage('session-2', { tool: 'write', arguments: { id: 1 } })
  first.stage('session-2', { tool: 'write', arguments: { id: 2 } })
  const review = first.review('session-2')
  assert.equal(first.beginCommit('session-2', review.digest, review.approval_nonce).ok, true)
  first.markSucceeded('session-2', 'action-1', { ok: true, output_preview: 'done' })

  const restored = new OutboxLedger({ maxActions: 3, maxPendingMs: 0, store })
  const recovery = restored.inspect('session-2')
  assert.equal(recovery.phase, 'recovery_required')
  assert.deepEqual(recovery.actions.map(action => action.status), ['succeeded', 'ambiguous'])
  assert.equal(restored.reviewCandidate('session-2').code, 'outbox_not_open')
  assert.equal(restored.beginCommit('session-2', recovery.digest, 'approve_replay').code, 'outbox_not_open')
  const discarded = restored.discard('session-2')
  assert.equal(discarded.external_actions_executed, 1)
  assert.equal(discarded.ambiguous_actions, 1)
})

test('editing invalidates the digest, nonce, acknowledgement, and duplicate safety is retained', () => {
  const owner = {}
  const ledger = new OutboxLedger({ maxActions: 3 })
  ledger.begin(owner, 'editable')
  ledger.stage(owner, { tool: 'send', arguments: { value: 'first' } })
  ledger.stage(owner, { tool: 'send', arguments: { value: 'second' } })
  const reviewed = ledger.review(owner, { requiresAcknowledgement: true })
  assert.equal(ledger.acknowledge(owner, reviewed.digest, reviewed.approval_nonce).review_acknowledged, true)

  const duplicate = ledger.replace(owner, 'action-2', { arguments: { value: 'first' } })
  assert.equal(duplicate.code, 'duplicate_action')
  const edited = ledger.replace(owner, 'action-2', { arguments: { value: 'replacement' } })
  assert.equal(edited.reviewed, false)
  assert.equal(edited.approval_nonce, null)
  assert.notEqual(edited.digest, reviewed.digest)
  assert.equal(ledger.beginCommit(owner, reviewed.digest, reviewed.approval_nonce).code, 'digest_mismatch')

  const rereviewed = ledger.review(owner, { requiresAcknowledgement: true })
  assert.equal(ledger.beginCommit(
    owner, rereviewed.digest, rereviewed.approval_nonce, { requireAcknowledgement: true },
  ).code, 'full_review_required')
  assert.equal(ledger.acknowledge(
    owner, rereviewed.digest, rereviewed.approval_nonce,
  ).review_acknowledged, true)
  assert.equal(ledger.beginCommit(
    owner, rereviewed.digest, rereviewed.approval_nonce, { requireAcknowledgement: true },
  ).ok, true)
})
