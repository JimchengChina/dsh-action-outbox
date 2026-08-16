import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as ActionOutbox from '../index.js'

const signal = new AbortController().signal

async function setup(config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ActionOutbox, config)
  return ctx
}

function call(ctx, callId, name, args = {}) {
  return ctx.tools.execute({ callId, name, arguments: args, signal })
}

function valueOf(result) {
  assert.equal(result.isError, false, result.isError ? result.error.message : undefined)
  return result.value
}

function stringTool(name, body) {
  return defineTool({
    name,
    description: name,
    parameters: { value: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return body(args)
    },
  })
}

test('staging has zero target side effects and commit executes in order', async () => {
  const ctx = await setup({ requireApproval: false })
  const effects = []
  ctx.tools.register(stringTool('external_write', args => {
    effects.push(args.value)
    return `wrote:${args.value}`
  }))

  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'two writes' }))
  valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'external_write', arguments: { value: 'one' }, summary: 'first',
  }))
  valueOf(await call(ctx, 's2', 'action_outbox_stage', {
    tool: 'external_write', arguments: { value: 'two' }, summary: 'second',
  }))
  assert.deepEqual(effects, [])

  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))
  const committed = valueOf(await call(ctx, 'c1', 'action_outbox_commit', {
    expected_digest: review.digest,
  }))
  assert.equal(committed.phase, 'committed')
  assert.deepEqual(effects, ['one', 'two'])
  await ctx.root.fiber.dispose()
})

test('enforced tools reject direct calls but allow reviewed commit lineage', async () => {
  const ctx = await setup({ requireApproval: false, enforce: ['danger_*'] })
  let effects = 0
  ctx.tools.register(stringTool('danger_write', () => {
    effects += 1
    return 'ok'
  }))

  const direct = await call(ctx, 'd1', 'danger_write', { value: 'direct' })
  assert.equal(direct.isError, true)
  assert.equal(effects, 0)

  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'guarded' }))
  const staged = valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'danger_write', arguments: { value: 'staged' },
  }))
  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))
  const committed = valueOf(await call(ctx, 'c1', 'action_outbox_commit', {
    expected_digest: review.digest,
  }))
  assert.equal(committed.phase, 'committed')
  assert.equal(effects, 1)
  await ctx.root.fiber.dispose()
})

test('approval is fail-closed when no approval service is mounted', async () => {
  const ctx = await setup()
  let effects = 0
  ctx.tools.register(stringTool('external_write', () => {
    effects += 1
    return 'ok'
  }))
  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'approval' }))
  const staged = valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'external_write', arguments: { value: 'x' },
  }))
  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))
  const result = await call(ctx, 'c1', 'action_outbox_commit', { expected_digest: review.digest })
  assert.equal(result.isError, true)
  assert.equal(effects, 0)
  await ctx.root.fiber.dispose()
})

test('commit stops on first failure and keeps a non-retryable partial receipt', async () => {
  const ctx = await setup({ requireApproval: false })
  const effects = []
  ctx.tools.register(stringTool('write_ok', args => {
    effects.push(args.value)
    return 'ok'
  }))
  ctx.tools.register(stringTool('write_fail', () => {
    throw new Error('ambiguous external failure')
  }))

  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'partial' }))
  valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'write_ok', arguments: { value: 'done' },
  }))
  const staged = valueOf(await call(ctx, 's2', 'action_outbox_stage', {
    tool: 'write_fail', arguments: { value: 'unknown' },
  }))
  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))
  const commit = valueOf(await call(ctx, 'c1', 'action_outbox_commit', {
    expected_digest: review.digest,
  }))
  assert.equal(commit.code, 'action_failed')
  assert.equal(commit.outbox.phase, 'blocked')
  assert.deepEqual(commit.outbox.actions.map(action => action.status), ['succeeded', 'failed'])
  assert.deepEqual(effects, ['done'])

  const retry = valueOf(await call(ctx, 'c2', 'action_outbox_commit', {
    expected_digest: commit.outbox.digest,
  }))
  assert.equal(retry.code, 'outbox_not_open')
  assert.deepEqual(effects, ['done'])
  await ctx.root.fiber.dispose()
})

test('staging rejects invalid target arguments before they can enter a batch', async () => {
  const ctx = await setup({ requireApproval: false })
  ctx.tools.register(stringTool('typed_write', () => 'ok'))
  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'typed' }))
  const staged = valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'typed_write', arguments: { value: 42 },
  }))
  assert.equal(staged.code, 'invalid_target_arguments')
  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))
  assert.equal(review.action_count, 0)
  await ctx.root.fiber.dispose()
})

test('tool identity drift blocks the whole commit before its first side effect', async () => {
  const ctx = await setup({ requireApproval: false })
  let effects = 0
  const dispose = ctx.tools.register(stringTool('hot_write', () => {
    effects += 1
    return 'old'
  }))
  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'hmr-safe' }))
  const staged = valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'hot_write', arguments: { value: 'x' },
  }))
  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))

  dispose()
  ctx.tools.register(stringTool('hot_write', () => {
    effects += 1
    return 'new'
  }))
  const commit = valueOf(await call(ctx, 'c1', 'action_outbox_commit', {
    expected_digest: review.digest,
  }))
  assert.equal(commit.code, 'commit_preflight_failed')
  assert.equal(effects, 0)
  await ctx.root.fiber.dispose()
})

test('review detects target identity drift before approval or commit', async () => {
  const ctx = await setup({ requireApproval: false })
  const dispose = ctx.tools.register(stringTool('hot_write', () => 'old'))
  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'review preflight' }))
  const staged = valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'hot_write', arguments: { value: 'x' },
  }))

  dispose()
  ctx.tools.register(stringTool('hot_write', () => 'new'))
  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))
  assert.equal(review.code, 'review_preflight_failed')
  assert.equal(review.outbox.reviewed, false)

  const commit = valueOf(await call(ctx, 'c1', 'action_outbox_commit', {
    expected_digest: staged.digest,
  }))
  assert.equal(commit.code, 'review_required')
  await ctx.root.fiber.dispose()
})

test('commit requires an explicit review after the final staged change', async () => {
  const ctx = await setup({ requireApproval: false })
  let effects = 0
  ctx.tools.register(stringTool('external_write', () => {
    effects += 1
    return 'ok'
  }))

  valueOf(await call(ctx, 'b1', 'action_outbox_begin', { label: 'review gate' }))
  const staged = valueOf(await call(ctx, 's1', 'action_outbox_stage', {
    tool: 'external_write', arguments: { value: 'x' },
  }))
  assert.equal(staged.reviewed, false)

  const skipped = valueOf(await call(ctx, 'c1', 'action_outbox_commit', {
    expected_digest: staged.digest,
  }))
  assert.equal(skipped.code, 'review_required')
  assert.equal(effects, 0)

  const review = valueOf(await call(ctx, 'r1', 'action_outbox_review'))
  assert.equal(review.reviewed, true)
  const committed = valueOf(await call(ctx, 'c2', 'action_outbox_commit', {
    expected_digest: review.digest,
  }))
  assert.equal(committed.phase, 'committed')
  assert.equal(effects, 1)
  await ctx.root.fiber.dispose()
})
