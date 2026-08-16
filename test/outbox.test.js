import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvalReason,
  batchDigest,
  compilePolicy,
  OutboxLedger,
  resolveConfig,
  utf8Bytes,
} from '../lib/outbox.js'

test('digest is stable across object key order and changes with the batch', () => {
  const first = [{ id: 'a', tool: 'send', arguments: { b: 2, a: 1 }, summary: 'x' }]
  const reordered = [{ id: 'a', tool: 'send', arguments: { a: 1, b: 2 }, summary: 'x' }]
  assert.equal(batchDigest(first), batchDigest(reordered))
  reordered[0].arguments.a = 3
  assert.notEqual(batchDigest(first), batchDigest(reordered))
})

test('policy supports wildcard include, exclude, and opt-in enforcement', () => {
  const policy = compilePolicy(resolveConfig({
    include: ['github_*', 'slack_*'],
    exclude: ['github_get_*'],
    enforce: ['github_*'],
  }))
  assert.equal(policy.mayStage('github_create_issue'), true)
  assert.equal(policy.mustStage('github_create_issue'), true)
  assert.equal(policy.mayStage('github_get_issue'), false)
  assert.equal(policy.mustStage('slack_send'), false)
  assert.equal(policy.mayStage('action_outbox_commit'), false)
})

test('ledger requires an exact reviewed digest and never repeats a completed batch', () => {
  const owner = {}
  const ledger = new OutboxLedger({ maxActions: 3 })
  assert.equal(ledger.begin(owner, 'release').ok, true)
  const staged = ledger.stage(owner, { tool: 'deploy', arguments: { env: 'prod' }, summary: 'Deploy' })
  assert.equal(staged.action_count, 1)

  const mismatch = ledger.beginCommit(owner, 'sha256:not-the-review')
  assert.equal(mismatch.code, 'digest_mismatch')

  const started = ledger.beginCommit(owner, staged.digest)
  assert.equal(started.ok, true)
  ledger.markSucceeded(owner, 'action-1', { ok: true, output_preview: 'done' })
  const finished = ledger.finish(owner)
  assert.equal(finished.phase, 'committed')
  assert.equal(ledger.review(owner).code, 'no_open_outbox')
})

test('a failed commit is blocked and cannot be retried accidentally', () => {
  const owner = {}
  const ledger = new OutboxLedger({ maxActions: 3 })
  ledger.begin(owner, 'publish')
  const review = ledger.stage(owner, { tool: 'publish', arguments: { id: 1 } })
  ledger.beginCommit(owner, review.digest)
  ledger.block(owner, 'action-1', { ok: false, error: 'timeout' })
  const blocked = ledger.review(owner)
  assert.equal(blocked.phase, 'blocked')
  assert.equal(blocked.actions[0].status, 'failed')
  assert.equal(ledger.beginCommit(owner, blocked.digest).code, 'outbox_not_open')
  assert.equal(ledger.discard(owner).external_actions_executed, 0)
})

test('limits use UTF-8 bytes and approval previews remain bounded', () => {
  assert.equal(utf8Bytes({ text: '深' }), 14)
  const owner = {}
  const ledger = new OutboxLedger({ maxActions: 1 })
  const review = ledger.begin(owner, 'bounded')
  ledger.stage(owner, { tool: 'send', arguments: { text: 'x'.repeat(200) } })
  const reason = approvalReason(ledger.review(owner), 80)
  assert.ok(reason.length < 120)
  assert.equal(review.action_count, 0)
})
