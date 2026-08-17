import z from '@deepseek-ai/schemastery'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  approvalPacket,
  compilePolicy,
  OutboxLedger,
  resolveConfig,
  resultReceipt,
  toolFingerprint,
  toolSource,
  utf8Bytes,
} from './lib/outbox.js'
import { defaultStateFile, JsonStateStore } from './lib/persistence.js'
import { outboxPresentation, presentationMeta } from './lib/presentation.js'

export const name = 'action-outbox'
export const inject = ['systemPrompt', 'tools']

export const Config = z.object({
  include: z.array(z.string()).default(['*']),
  exclude: z.array(z.string()).default([]),
  enforce: z.array(z.string()).default([]),
  requireApproval: z.boolean().default(true),
  rejectDuplicateActions: z.boolean().default(true),
  persistPending: z.boolean().default(true),
  stateFile: z.string().default(''),
  maxPendingMs: z.natural().default(30 * 60 * 1000),
  maxActions: z.natural().min(1).default(20),
  maxArgumentBytes: z.natural().min(1).default(64 * 1024),
  resultPreviewChars: z.natural().min(1).default(2_000),
  approvalPreviewChars: z.natural().min(1).default(4_000),
})

const FALLBACK_OWNER = Symbol('unscoped-action-outbox')
const MAX_LABEL_CHARS = 200
const MAX_SUMMARY_CHARS = 500
const INBOX_ROUTE = '/plugins/action-outbox/inbox'

function ownerOf(exec) {
  const id = exec.agent?.id
  return id === undefined || id === null ? FALLBACK_OWNER : String(id)
}

function bindingFor(ownerId, agent) {
  const header = agent?.session?.header
  return {
    ...(typeof ownerId === 'string' ? { owner_id: ownerId } : {}),
    ...(agent?.id === undefined ? {} : { agent_id: String(agent.id) }),
    ...(header?.id === undefined ? {} : { session_id: String(header.id) }),
    ...(typeof header?.cwd === 'string' ? { workspace: header.cwd } : {}),
    ...(typeof header?.origin === 'string' ? { origin: header.origin } : {}),
    ...(typeof header?.agentPreset === 'string' ? { agent_preset: header.agentPreset } : {}),
  }
}

function ownerBinding(exec) {
  return bindingFor(ownerOf(exec), exec.agent)
}

function bindingIssue(review, owner, agent) {
  if (!review.ok) return undefined
  const current = bindingFor(owner, agent)
  for (const field of ['owner_id', 'agent_id', 'session_id', 'workspace']) {
    if (review.owner[field] !== undefined && current[field] !== review.owner[field]) {
      return `Outbox binding mismatch for ${field}; stored intent cannot move to another session or workspace.`
    }
  }
  return undefined
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function jsonOutput() {
  return { schema: { type: 'json' }, render: renderJson, presentationMeta: (_args, value) => presentationMeta(value) }
}

function expectedDigest(value) {
  if (value === null || typeof value !== 'object') return undefined
  return typeof value.expected_digest === 'string' ? value.expected_digest : undefined
}

function approvalNonce(value) {
  if (value === null || typeof value !== 'object') return undefined
  return typeof value.approval_nonce === 'string' ? value.approval_nonce : undefined
}

function preflightActions(ctx, policy, actions, agent) {
  const definitions = new Map()
  for (const action of actions) {
    if (!policy.mayStage(action.tool)) {
      return {
        action,
        detail: `Tool "${action.tool}" is no longer allowed by the action-outbox policy.`,
      }
    }
    const target = ctx.tools.get(action.tool, agent)
    if (target === undefined) {
      return { action, detail: `Tool "${action.tool}" was removed or is no longer visible.` }
    }
    const currentFingerprint = toolFingerprint(target)
    const changed = (action.definition !== undefined && target !== action.definition)
      || (action.definitionFingerprint !== undefined
        && currentFingerprint !== action.definitionFingerprint)
    if (changed) {
      return {
        action,
        detail: `Tool "${action.tool}" was replaced or its schema/identity changed after staging.`,
      }
    }
    const violations = validateJsonSchemaValue(target.parameters, action.arguments, 'arguments')
    if (violations.length > 0) {
      return {
        action,
        detail: `Arguments no longer satisfy "${action.tool}": ${violations.join('; ')}`,
      }
    }
    definitions.set(action.id, target)
  }
  return { definitions }
}

function validateAction(ctx, policy, config, input, agent) {
  if (typeof input.tool !== 'string' || input.tool.length === 0) {
    return {
      ok: false,
      code: 'invalid_target_tool',
      message: 'Target tool must be a non-empty string.',
    }
  }
  if (input.arguments === undefined) {
    return {
      ok: false,
      code: 'invalid_target_arguments',
      message: 'Target arguments are required.',
    }
  }
  if (input.summary !== undefined && typeof input.summary !== 'string') {
    return {
      ok: false,
      code: 'invalid_summary',
      message: 'Action summary must be a string when provided.',
    }
  }
  if (!policy.mayStage(input.tool)) {
    return {
      ok: false,
      code: 'tool_not_stageable',
      message: `Tool "${input.tool}" is excluded, internal, or outside the configured include patterns.`,
    }
  }
  const target = ctx.tools.get(input.tool, agent)
  if (target === undefined) {
    return {
      ok: false,
      code: 'unknown_or_hidden_tool',
      message: `Tool "${input.tool}" is not visible to this agent.`,
    }
  }
  const violations = validateJsonSchemaValue(target.parameters, input.arguments, 'arguments')
  if (violations.length > 0) {
    return {
      ok: false,
      code: 'invalid_target_arguments',
      message: `Arguments do not satisfy "${input.tool}": ${violations.join('; ')}`,
    }
  }
  if (input.summary !== undefined && input.summary.length > MAX_SUMMARY_CHARS) {
    return {
      ok: false,
      code: 'summary_too_long',
      message: `Summary uses ${input.summary.length} characters; the limit is ${MAX_SUMMARY_CHARS}.`,
    }
  }
  const bytes = utf8Bytes(input.arguments)
  if (bytes > config.maxArgumentBytes) {
    return {
      ok: false,
      code: 'arguments_too_large',
      message: `Arguments use ${bytes} UTF-8 bytes; the configured limit is ${config.maxArgumentBytes}.`,
    }
  }
  return {
    ok: true,
    action: {
      ...input,
      definition: target,
      definitionFingerprint: toolFingerprint(target),
      toolSource: toolSource(target),
    },
  }
}

function reviewOwner(ctx, ledger, policy, config, owner, agent) {
  const candidate = ledger.reviewCandidate(owner)
  if (!candidate.ok) return candidate
  const binding = bindingIssue(ledger.inspect(owner), owner, agent)
  if (binding !== undefined) {
    return { ok: false, code: 'owner_binding_mismatch', message: binding, outbox: ledger.inspect(owner) }
  }
  const preflight = preflightActions(ctx, policy, candidate.actions, agent)
  if (preflight.detail !== undefined) {
    return {
      ok: false,
      code: 'review_preflight_failed',
      message: `${preflight.detail} Edit or restage the action before requesting approval.`,
      outbox: ledger.inspect(owner),
    }
  }
  let review = ledger.review(owner, { definitions: preflight.definitions })
  const packet = approvalPacket(review, config.approvalPreviewChars)
  if (packet.truncated) {
    review = ledger.requireFullAcknowledgement(owner, review.digest, review.approval_nonce)
  }
  return {
    ...review,
    approval_preview_truncated: packet.truncated,
    approval_preview_chars: packet.full_chars,
    review_surface: 'Batch Review Inbox in the DSH sidebar',
  }
}

function dispatchMetadata(callId, startedAt) {
  const finishedAt = Date.now()
  return {
    call_id: callId,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: Math.max(0, finishedAt - startedAt),
  }
}

function writeJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try { return new URL(origin).host === host } catch { return false }
}

async function readJson(req, maxBytes) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object')
  }
  return value
}

function apiStatus(result) {
  if (result.ok) return 200
  if (result.code === 'no_open_outbox' || result.code === 'unknown_action') return 404
  if (result.code === 'agent_not_active') return 409
  return 400
}

function registerInboxApi(ctx, { ledger, activeAgents, review, replace, discard, maxBodyBytes }) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: INBOX_ROUTE,
      async handler(req, res) {
        const pathname = new URL(req.url ?? '/', 'http://local').pathname
        if (req.method === 'GET' && pathname === INBOX_ROUTE) {
          writeJson(res, 200, { ok: true, outboxes: ledger.list() })
          return
        }
        if (req.method !== 'POST' || !sameOrigin(req)) {
          writeJson(res, req.method === 'POST' ? 403 : 405, {
            ok: false,
            code: req.method === 'POST' ? 'origin_mismatch' : 'method_not_allowed',
            message: req.method === 'POST' ? 'Mutation requires the same DSH origin.' : 'Method not allowed.',
          })
          return
        }

        let body
        try { body = await readJson(req, maxBodyBytes) } catch (error) {
          writeJson(res, 400, { ok: false, code: 'invalid_json', message: String(error.message ?? error) })
          return
        }
        if (typeof body.owner_id !== 'string') {
          writeJson(res, 400, { ok: false, code: 'owner_required', message: 'owner_id is required.' })
          return
        }
        const owner = body.owner_id
        let result
        if (pathname === `${INBOX_ROUTE}/acknowledge`) {
          result = ledger.acknowledge(owner, body.expected_digest, body.approval_nonce)
        } else if (pathname === `${INBOX_ROUTE}/review`) {
          const agent = activeAgents.get(owner)
          result = agent === undefined
            ? { ok: false, code: 'agent_not_active', message: 'Run action_outbox_review from this DSH session once, then refresh the Inbox.' }
            : review(owner, agent)
        } else if (pathname === `${INBOX_ROUTE}/replace`) {
          const agent = activeAgents.get(owner)
          result = agent === undefined
            ? { ok: false, code: 'agent_not_active', message: 'Run action_outbox_review from this DSH session once, then edit again.' }
            : replace(owner, body, agent)
        } else if (pathname === `${INBOX_ROUTE}/discard`) {
          result = discard(owner)
        } else {
          writeJson(res, 404, { ok: false, code: 'not_found', message: 'Unknown action-outbox endpoint.' })
          return
        }
        writeJson(res, apiStatus(result), result)
      },
    }), 'action-outbox: Batch Review Inbox API')
  })
}

export function apply(ctx, inputConfig = {}) {
  const config = resolveConfig(inputConfig)
  const policy = compilePolicy(config)
  const store = config.persistPending
    ? new JsonStateStore(config.stateFile.length === 0 ? defaultStateFile() : config.stateFile)
    : undefined
  const ledger = new OutboxLedger({ ...config, store })
  const commitDispatches = new Map()
  const activeAgents = new Map()

  const rememberAgent = exec => {
    if (exec.agent !== undefined) activeAgents.set(ownerOf(exec), exec.agent)
  }

  const review = (owner, agent) => reviewOwner(ctx, ledger, policy, config, owner, agent)

  const replace = (owner, args, agent) => {
    const current = ledger.inspect(owner)
    if (!current.ok) return current
    const previous = current.actions.find(action => action.id === args.action_id)
    if (previous === undefined) {
      return { ok: false, code: 'unknown_action', message: `No action named "${args.action_id}".` }
    }
    const input = {
      tool: typeof args.tool === 'string' ? args.tool : previous.tool,
      arguments: Object.hasOwn(args, 'arguments') ? args.arguments : previous.arguments,
      ...(Object.hasOwn(args, 'summary')
        ? { summary: args.summary }
        : previous.summary === undefined ? {} : { summary: previous.summary }),
    }
    const validated = validateAction(ctx, policy, config, input, agent)
    if (!validated.ok) return validated
    return ledger.replace(owner, args.action_id, {
      ...(Object.hasOwn(args, 'tool') ? { tool: validated.action.tool } : {}),
      ...(Object.hasOwn(args, 'arguments') ? { arguments: validated.action.arguments } : {}),
      ...(Object.hasOwn(args, 'summary') ? { summary: validated.action.summary } : {}),
      definition: validated.action.definition,
      definitionFingerprint: validated.action.definitionFingerprint,
      toolSource: validated.action.toolSource,
    }, {
      expectedDigest: typeof args.expected_digest === 'string' ? args.expected_digest : undefined,
      approvalNonce: typeof args.approval_nonce === 'string' ? args.approval_nonce : undefined,
    })
  }

  const discard = owner => {
    const result = ledger.discard(owner)
    if (result.ok) activeAgents.delete(owner)
    return result
  }

  registerInboxApi(ctx, {
    ledger,
    activeAgents,
    review,
    replace,
    discard,
    maxBodyBytes: Math.min(4 * 1024 * 1024, Math.max(256 * 1024, config.maxArgumentBytes * 2)),
  })

  ctx.systemPrompt.section({
    name: 'tool:action-outbox',
    order: 119,
    text:
      'Use the action outbox when several side-effecting tool calls should be reviewed as one batch. '
      + 'Call action_outbox_begin, stage every action without executing it, optionally unstage or replace mistakes, '
      + 'then call action_outbox_review and pass its exact digest and approval nonce to action_outbox_commit. '
      + 'A replace invalidates every earlier digest, nonce, review, and approval. If review reports a truncated '
      + 'approval preview, the user must inspect and acknowledge the full canonical JSON in Batch Review Inbox. '
      + 'A restored batch always needs a fresh live preflight and approval. Never claim a staged action happened. '
      + 'After commit starts, external systems are not atomic: stop on failure and report the partial receipt; '
      + 'never retry an ambiguous restored action or claim rollback.',
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    rememberAgent(exec)
    if (exec.name !== 'action_outbox_commit' || !config.requireApproval) return next()
    const digest = expectedDigest(exec.arguments)
    const nonce = approvalNonce(exec.arguments)
    const reviewed = ledger.inspect(ownerOf(exec))
    if (!reviewed.ok || reviewed.phase !== 'open' || !reviewed.reviewed
      || digest === undefined || reviewed.digest !== digest
      || nonce === undefined || reviewed.approval_nonce !== nonce
      || (reviewed.review_requires_full_ack && !reviewed.review_acknowledged)) return next()
    return { kind: 'ask', reason: approvalPacket(reviewed, config.approvalPreviewChars).reason }
  })

  ctx.tools.guard(exec => {
    if (!policy.mustStage(exec.name)) return undefined
    const expected = exec.parent === undefined ? undefined : commitDispatches.get(exec.parent)
    if (expected?.name === exec.name && expected.callId === exec.callId) return undefined
    return `Tool "${exec.name}" is configured for transactional dispatch. Stage it with action_outbox_stage and commit the reviewed batch.`
  })

  ctx.tools.register(defineTool({
    name: 'action_outbox_begin',
    description: 'Open an empty durable action outbox. Staging records intent only and performs no target tool side effects.',
    parameters: {
      label: { type: 'string', required: true, description: 'Short purpose of this batch.' },
    },
    output: jsonOutput(),
    ...outboxPresentation('begin'),
    async execute(args, exec) {
      rememberAgent(exec)
      if (args.label.length > MAX_LABEL_CHARS) {
        return {
          ok: false,
          code: 'label_too_long',
          message: `Label uses ${args.label.length} characters; the limit is ${MAX_LABEL_CHARS}.`,
        }
      }
      return ledger.begin(ownerOf(exec), args.label, ownerBinding(exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_stage',
    description: 'Stage one visible tool call without executing it. Full canonical arguments remain available in Batch Review Inbox.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Exact target tool name.' },
      arguments: { type: 'json', required: true, description: 'Exact JSON arguments to pass at commit time.' },
      summary: { type: 'string', description: 'Concise human-readable description of the intended side effect.' },
    },
    output: jsonOutput(),
    ...outboxPresentation('stage'),
    async execute(args, exec) {
      rememberAgent(exec)
      const validated = validateAction(ctx, policy, config, args, exec.agent)
      return validated.ok ? ledger.stage(ownerOf(exec), validated.action) : validated
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_unstage',
    description: 'Remove one pending action. The change invalidates the prior digest, nonce, review, and approval.',
    parameters: {
      action_id: { type: 'string', required: true, description: 'Exact action id returned while staging.' },
    },
    output: jsonOutput(),
    ...outboxPresentation('unstage'),
    async execute(args, exec) {
      rememberAgent(exec)
      return ledger.unstage(ownerOf(exec), args.action_id)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_replace',
    description: 'Edit one staged action without executing it. Revalidates the live target schema and invalidates every prior review and approval.',
    parameters: {
      action_id: { type: 'string', required: true, description: 'Exact staged action id.' },
      tool: { type: 'string', description: 'Replacement target tool; omit to keep the current tool.' },
      arguments: { type: 'json', description: 'Replacement exact JSON arguments; omit to keep current arguments.' },
      summary: { type: 'string', description: 'Replacement human-readable summary.' },
    },
    output: jsonOutput(),
    ...outboxPresentation('replace'),
    async execute(args, exec) {
      rememberAgent(exec)
      return replace(ownerOf(exec), args, exec.agent)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_review',
    description: 'Re-resolve policy, tool identity, and schema; return the exact batch digest and a new single-use approval nonce.',
    parameters: {},
    output: jsonOutput(),
    ...outboxPresentation('review'),
    async execute(_args, exec) {
      rememberAgent(exec)
      return review(ownerOf(exec), exec.agent)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_commit',
    description: 'Commit the exact reviewed batch in order. Requires the final digest and its single-use nonce from the same action_outbox_review tool result, or from the Inbox “Next: copy exact commit prompt” handoff. Never infer UI-only review credentials from older chat history. Stops at the first failure and never retries automatically.',
    parameters: {
      expected_digest: {
        type: 'string',
        required: true,
        description: 'Exact full digest from the same current review handoff; do not reuse an older value from chat history.',
      },
      approval_nonce: {
        type: 'string',
        required: true,
        description: 'Exact single-use nonce paired with expected_digest by the same current review handoff.',
      },
    },
    output: jsonOutput(),
    ...outboxPresentation('commit'),
    async execute(args, exec) {
      rememberAgent(exec)
      const owner = ownerOf(exec)
      const binding = bindingIssue(ledger.inspect(owner), owner, exec.agent)
      if (binding !== undefined) {
        return { ok: false, code: 'owner_binding_mismatch', message: binding, outbox: ledger.inspect(owner) }
      }
      const started = ledger.beginCommit(owner, args.expected_digest, args.approval_nonce, {
        requireAcknowledgement: config.requireApproval,
      })
      if (!started.ok) return started

      const preflight = preflightActions(ctx, policy, started.actions, exec.agent)
      if (preflight.detail !== undefined) {
        ledger.block(owner, preflight.action.id, { ok: false, error: preflight.detail })
        return {
          ok: false,
          code: 'commit_preflight_failed',
          message: `${preflight.detail} No target action was dispatched.`,
          outbox: ledger.inspect(owner),
        }
      }

      try {
        for (const action of started.actions) {
          if (exec.signal.aborted) {
            const receipt = { ok: false, error: 'Commit cancelled before this action was dispatched.' }
            ledger.block(owner, action.id, receipt)
            return {
              ok: false,
              code: 'commit_cancelled',
              message: 'Commit stopped. Earlier successful actions were not rolled back.',
              outbox: ledger.inspect(owner),
            }
          }

          let result
          const callId = `${exec.callId}:outbox:${started.state.id}:${action.id}`
          const startedAt = Date.now()
          commitDispatches.set(exec.token, { callId, name: action.tool })
          try {
            result = await ctx.tools.execute({
              callId,
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
              ...(error instanceof Error ? { error_name: error.name } : {}),
              ...dispatchMetadata(callId, startedAt),
            }
            ledger.block(owner, action.id, receipt)
            return {
              ok: false,
              code: 'commit_dispatch_failed',
              message: 'Commit stopped. Earlier successful actions were not rolled back.',
              outbox: ledger.inspect(owner),
            }
          } finally {
            commitDispatches.delete(exec.token)
          }

          const receipt = resultReceipt(
            result,
            config.resultPreviewChars,
            dispatchMetadata(callId, startedAt),
          )
          if (!receipt.ok) {
            ledger.block(owner, action.id, receipt)
            return {
              ok: false,
              code: 'action_failed',
              message: `Commit stopped at ${action.id}. Earlier successful actions were not rolled back.`,
              outbox: ledger.inspect(owner),
            }
          }
          ledger.markSucceeded(owner, action.id, receipt)
        }
        const result = ledger.finish(owner)
        if (result.ok) activeAgents.delete(owner)
        return result
      } finally {
        commitDispatches.delete(exec.token)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'action_outbox_discard',
    description: 'Discard an open, blocked, expired, or recovery-required outbox. Ambiguous or succeeded external actions cannot be undone.',
    parameters: {},
    output: jsonOutput(),
    ...outboxPresentation('discard'),
    async execute(_args, exec) {
      rememberAgent(exec)
      return discard(ownerOf(exec))
    },
  }))
}
