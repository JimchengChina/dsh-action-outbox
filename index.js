import z from '@deepseek-ai/schemastery'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  approvalReason,
  compilePolicy,
  OutboxLedger,
  resolveConfig,
  resultReceipt,
  utf8Bytes,
} from './lib/outbox.js'

export const name = 'action-outbox'
export const inject = ['systemPrompt', 'tools']

export const Config = z.object({
  include: z.array(z.string()).default(['*']),
  exclude: z.array(z.string()).default([]),
  enforce: z.array(z.string()).default([]),
  requireApproval: z.boolean().default(true),
  maxActions: z.natural().min(1).default(20),
  maxArgumentBytes: z.natural().min(1).default(64 * 1024),
  resultPreviewChars: z.natural().min(1).default(2_000),
  approvalPreviewChars: z.natural().min(1).default(4_000),
})

const FALLBACK_OWNER = Object.freeze({ kind: 'unscoped-action-outbox' })
const MAX_LABEL_CHARS = 200
const MAX_SUMMARY_CHARS = 500

function ownerOf(exec) {
  return exec.agent ?? FALLBACK_OWNER
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function jsonOutput() {
  return { schema: { type: 'json' }, render: renderJson }
}

function expectedDigest(value) {
  if (value === null || typeof value !== 'object') return undefined
  return typeof value.expected_digest === 'string' ? value.expected_digest : undefined
}

function preflightActions(ctx, actions, agent) {
  for (const action of actions) {
    const target = ctx.tools.get(action.tool, agent)
    const changed = target === undefined || target !== action.definition
    const violations = target === undefined
      ? []
      : validateJsonSchemaValue(target.parameters, action.arguments, 'arguments')
    if (changed || violations.length > 0) {
      return {
        action,
        detail: changed
          ? `Tool "${action.tool}" was removed or replaced after staging.`
          : `Arguments no longer satisfy "${action.tool}": ${violations.join('; ')}`,
      }
    }
  }
  return undefined
}

export function apply(ctx, inputConfig = {}) {
  const config = resolveConfig(inputConfig)
  const policy = compilePolicy(config)
  const ledger = new OutboxLedger(config)
  const commitLineage = new Set()

  ctx.systemPrompt.section({
    name: 'tool:action-outbox',
    order: 119,
    text:
      'Use the action outbox when several side-effecting tool calls should be reviewed as one batch. '
      + 'Call action_outbox_begin, stage every action without executing it, call action_outbox_review, '
      + 'then pass the exact returned digest to action_outbox_commit. Do not claim that a staged action '
      + 'has happened. Before commit, action_outbox_discard guarantees that none of the staged actions ran. '
      + 'After commit starts, external systems are not atomic: if one action fails, stop and report the '
      + 'partial receipt instead of retrying or claiming rollback.',
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.parent !== undefined && commitLineage.has(exec.parent)) {
      commitLineage.add(exec.token)
    }
    if (exec.name !== 'action_outbox_commit' || !config.requireApproval) return next()
    const digest = expectedDigest(exec.arguments)
    const review = ledger.inspect(ownerOf(exec))
    if (!review.ok || digest === undefined || review.digest !== digest) return next()
    return { kind: 'ask', reason: approvalReason(review, config.approvalPreviewChars) }
  })

  ctx.on('tools/result', exec => {
    commitLineage.delete(exec.token)
  })

  ctx.tools.guard(exec => {
    if (!policy.mustStage(exec.name)) return undefined
    if (exec.parent !== undefined && commitLineage.has(exec.parent)) return undefined
    return `Tool "${exec.name}" is configured for transactional dispatch. Stage it with action_outbox_stage and commit the reviewed batch.`
  })

  ctx.tools.register(defineTool({
    name: 'action_outbox_begin',
    description: 'Open an empty action outbox. Staging records intent only and performs no target tool side effects.',
    parameters: {
      label: { type: 'string', required: true, description: 'Short purpose of this batch.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      if (args.label.length > MAX_LABEL_CHARS) {
        return {
          ok: false,
          code: 'label_too_long',
          message: `Label uses ${args.label.length} characters; the limit is ${MAX_LABEL_CHARS}.`,
        }
      }
      return ledger.begin(ownerOf(exec), args.label)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_stage',
    description:
      'Stage one visible tool call in the current outbox without executing it. Use for writes or other external side effects whose results are not needed while planning the batch.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Exact target tool name.' },
      arguments: { type: 'json', required: true, description: 'Exact JSON arguments to pass at commit time.' },
      summary: { type: 'string', description: 'Concise human-readable description of the intended side effect.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      if (!policy.mayStage(args.tool)) {
        return {
          ok: false,
          code: 'tool_not_stageable',
          message: `Tool "${args.tool}" is excluded, internal, or outside the configured include patterns.`,
        }
      }
      const target = ctx.tools.get(args.tool, exec.agent)
      if (target === undefined) {
        return {
          ok: false,
          code: 'unknown_or_hidden_tool',
          message: `Tool "${args.tool}" is not visible to this agent.`,
        }
      }
      const violations = validateJsonSchemaValue(target.parameters, args.arguments, 'arguments')
      if (violations.length > 0) {
        return {
          ok: false,
          code: 'invalid_target_arguments',
          message: `Arguments do not satisfy "${args.tool}": ${violations.join('; ')}`,
        }
      }
      if (args.summary !== undefined && args.summary.length > MAX_SUMMARY_CHARS) {
        return {
          ok: false,
          code: 'summary_too_long',
          message: `Summary uses ${args.summary.length} characters; the limit is ${MAX_SUMMARY_CHARS}.`,
        }
      }
      const bytes = utf8Bytes(args.arguments)
      if (bytes > config.maxArgumentBytes) {
        return {
          ok: false,
          code: 'arguments_too_large',
          message: `Arguments use ${bytes} UTF-8 bytes; the configured limit is ${config.maxArgumentBytes}.`,
        }
      }
      return ledger.stage(ownerOf(exec), { ...args, definition: target })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_review',
    description:
      'Preflight every target against the live DSH registry, then mark and return the exact staged batch and digest required by action_outbox_commit.',
    parameters: {},
    output: jsonOutput(),
    async execute(_args, exec) {
      const owner = ownerOf(exec)
      const candidate = ledger.reviewCandidate(owner)
      if (!candidate.ok) return candidate.outbox ?? candidate
      const issue = preflightActions(ctx, candidate.actions, exec.agent)
      if (issue !== undefined) {
        return {
          ok: false,
          code: 'review_preflight_failed',
          message: `${issue.detail} Restage the action before requesting approval.`,
          outbox: ledger.inspect(owner),
        }
      }
      return ledger.review(ownerOf(exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_commit',
    description:
      'Commit the exact reviewed batch in order. Every target call re-enters the normal DSH policy, approval, sandbox, hook, and result pipeline. Stops at the first failure and never retries automatically.',
    parameters: {
      expected_digest: {
        type: 'string',
        required: true,
        description: 'Exact full digest returned by the latest action_outbox_review.',
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const owner = ownerOf(exec)
      const started = ledger.beginCommit(owner, args.expected_digest)
      if (!started.ok) return started

      // Validate the whole batch against the exact definitions captured while
      // staging before the first side effect. HMR or schema drift cannot turn a
      // previously reviewed name/argument pair into a different capability.
      const issue = preflightActions(ctx, started.actions, exec.agent)
      if (issue !== undefined) {
        ledger.block(owner, issue.action.id, { ok: false, error: issue.detail })
        return {
          ok: false,
          code: 'commit_preflight_failed',
          message: `${issue.detail} No target action was dispatched.`,
          outbox: ledger.review(owner),
        }
      }

      commitLineage.add(exec.token)
      try {
        for (const action of started.actions) {
          if (exec.signal.aborted) {
            const receipt = { ok: false, error: 'Commit cancelled before this action was dispatched.' }
            ledger.block(owner, action.id, receipt)
            return {
              ok: false,
              code: 'commit_cancelled',
              message: 'Commit stopped. Earlier successful actions were not rolled back.',
              outbox: ledger.review(owner),
            }
          }

          let result
          try {
            result = await ctx.tools.execute({
              callId: `${exec.callId}:outbox:${started.state.id}:${action.id}`,
              rootCallId: exec.rootCallId,
              name: action.tool,
              arguments: action.arguments,
              ...(exec.agent === undefined ? {} : { agent: exec.agent }),
              parent: exec.token,
              signal: exec.signal,
            })
          } catch (error) {
            const receipt = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }
            ledger.block(owner, action.id, receipt)
            return {
              ok: false,
              code: 'commit_dispatch_failed',
              message: 'Commit stopped. Earlier successful actions were not rolled back.',
              outbox: ledger.review(owner),
            }
          }

          const receipt = resultReceipt(result, config.resultPreviewChars)
          if (!receipt.ok) {
            ledger.block(owner, action.id, receipt)
            return {
              ok: false,
              code: 'action_failed',
              message: `Commit stopped at ${action.id}. Earlier successful actions were not rolled back.`,
              outbox: ledger.review(owner),
            }
          }
          ledger.markSucceeded(owner, action.id, receipt)
        }
        return ledger.finish(owner)
      } finally {
        commitLineage.delete(exec.token)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_discard',
    description:
      'Discard an open or blocked outbox. Pending staged actions have no side effects; actions already reported succeeded during a partial commit cannot be undone.',
    parameters: {},
    output: jsonOutput(),
    async execute(_args, exec) {
      return ledger.discard(ownerOf(exec))
    },
  }))
}
