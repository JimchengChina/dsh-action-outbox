import assert from 'node:assert/strict'
import test from 'node:test'
import { outboxPresentation, presentationMeta } from '../lib/presentation.js'

test('stage presentation keeps the exact target arguments visible', () => {
  const presentation = outboxPresentation('stage')
  assert.deepEqual(presentation.presentCall({
    tool: 'github_create_issue',
    arguments: { title: 'Ship it' },
    summary: 'Create release issue',
  }), {
    card: 'generic',
    title: 'Stage github_create_issue',
    kind: 'edit',
    rawInput: {
      tool: 'github_create_issue',
      arguments: { title: 'Ship it' },
      summary: 'Create release issue',
    },
  })
})

test('result presentation surfaces policy failures without hiding raw content', () => {
  const presentation = outboxPresentation('commit')
  assert.deepEqual(presentation.presentResult({}, {
    isError: false,
    content: [{ type: 'text', text: 'details remain available' }],
    meta: { ok: false, code: 'review_required' },
  }), {
    card: 'generic',
    title: 'Commit reviewed actions failed: review_required',
  })
})

test('presentation metadata exposes only compact batch state', () => {
  assert.deepEqual(presentationMeta({
    ok: true,
    phase: 'open',
    outbox_id: 'outbox-1',
    action_count: 2,
    reviewed: true,
    actions: [{ arguments: { secret: 'not copied into metadata' } }],
  }), {
    ok: true,
    phase: 'open',
    outbox_id: 'outbox-1',
    action_count: 2,
    reviewed: true,
  })
})
