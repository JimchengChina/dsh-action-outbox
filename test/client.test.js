import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apply,
  exactCommitPrompt,
  inject,
  safeDemoPrompt,
  splitOutboxes,
} from '../client.js'

test('browser half mounts only additive DSH sidebar and overlay seats', () => {
  const registrations = []
  const requested = []
  apply({
    slots: {
      inject(name, callback) {
        requested.push(name)
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })

  assert.deepEqual(inject, ['slots'])
  assert.deepEqual(requested, ['sidebar.footer.action', 'shell.overlay'])
  assert.deepEqual(registrations.map(item => item.options.name), requested)
  assert.ok(registrations.every(item => item.options.id === 'action-outbox-inbox'))
  assert.ok(registrations.every(item => typeof item.component === 'function'))
})

test('exact commit prompt uses only the current Inbox review credentials', () => {
  const prompt = exactCommitPrompt({
    reviewed: true,
    digest: 'sha256:current',
    approval_nonce: 'approve_current',
  })

  assert.match(prompt, /expected_digest "sha256:current"/)
  assert.match(prompt, /approval_nonce "approve_current"/)
  assert.match(prompt, /do not reuse any older digest or nonce/i)
  assert.equal(exactCommitPrompt({ reviewed: false, digest: 'sha256:draft', approval_nonce: null }), '')
})

test('expired outboxes are history and do not count as pending work', () => {
  const { active, history } = splitOutboxes([
    { outbox_id: 'open', phase: 'open' },
    { outbox_id: 'expired', phase: 'expired' },
    { outbox_id: 'recovery', phase: 'recovery_required' },
  ])

  assert.deepEqual(active.map(item => item.outbox_id), ['open', 'recovery'])
  assert.deepEqual(history.map(item => item.outbox_id), ['expired'])
})

test('safe demo prompt is deterministic and stops before commit', () => {
  const prompt = safeDemoPrompt(new Date('2026-08-18T02:03:04.000Z'))

  assert.match(prompt, /\/private\/tmp\/dsh-action-outbox-demo-20260818020304\.txt/)
  assert.match(prompt, /no-clobber/)
  assert.match(prompt, /action_outbox_review/)
  assert.match(prompt, /Do not call action_outbox_commit/)
  assert.match(prompt, /no network access/)
})
