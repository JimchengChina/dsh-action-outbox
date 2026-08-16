import { createHash } from 'node:crypto'

export const DEFAULT_CONFIG = Object.freeze({
  include: Object.freeze(['*']),
  exclude: Object.freeze([]),
  enforce: Object.freeze([]),
  requireApproval: true,
  rejectDuplicateActions: true,
  maxActions: 20,
  maxArgumentBytes: 64 * 1024,
  resultPreviewChars: 2_000,
  approvalPreviewChars: 4_000,
})

export const INTERNAL_TOOLS = Object.freeze(new Set([
  'action_outbox_begin',
  'action_outbox_stage',
  'action_outbox_unstage',
  'action_outbox_review',
  'action_outbox_commit',
  'action_outbox_discard',
  'run_code',
]))

function assertStringArray(value, field) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`action-outbox: \`${field}\` must contain non-empty strings`)
  }
  return [...value]
}

function assertPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`action-outbox: \`${field}\` must be a positive safe integer`)
  }
  return value
}

function assertBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`action-outbox: \`${field}\` must be a boolean`)
  }
  return value
}

export function resolveConfig(input = {}) {
  return Object.freeze({
    include: Object.freeze(assertStringArray(input.include ?? DEFAULT_CONFIG.include, 'include')),
    exclude: Object.freeze(assertStringArray(input.exclude ?? DEFAULT_CONFIG.exclude, 'exclude')),
    enforce: Object.freeze(assertStringArray(input.enforce ?? DEFAULT_CONFIG.enforce, 'enforce')),
    requireApproval: assertBoolean(
      input.requireApproval ?? DEFAULT_CONFIG.requireApproval,
      'requireApproval',
    ),
    rejectDuplicateActions: assertBoolean(
      input.rejectDuplicateActions ?? DEFAULT_CONFIG.rejectDuplicateActions,
      'rejectDuplicateActions',
    ),
    maxActions: assertPositiveSafeInteger(input.maxActions ?? DEFAULT_CONFIG.maxActions, 'maxActions'),
    maxArgumentBytes: assertPositiveSafeInteger(
      input.maxArgumentBytes ?? DEFAULT_CONFIG.maxArgumentBytes,
      'maxArgumentBytes',
    ),
    resultPreviewChars: assertPositiveSafeInteger(
      input.resultPreviewChars ?? DEFAULT_CONFIG.resultPreviewChars,
      'resultPreviewChars',
    ),
    approvalPreviewChars: assertPositiveSafeInteger(
      input.approvalPreviewChars ?? DEFAULT_CONFIG.approvalPreviewChars,
      'approvalPreviewChars',
    ),
  })
}

export function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

export function compilePolicy(config) {
  const include = config.include.map(wildcardToRegExp)
  const exclude = config.exclude.map(wildcardToRegExp)
  const enforce = config.enforce.map(wildcardToRegExp)
  const matches = (patterns, name) => patterns.some(pattern => pattern.test(name))
  return Object.freeze({
    mayStage(name) {
      return !INTERNAL_TOOLS.has(name)
        && matches(include, name)
        && !matches(exclude, name)
    },
    mustStage(name) {
      return !INTERNAL_TOOLS.has(name)
        && matches(enforce, name)
        && !matches(exclude, name)
    },
  })
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key])
    return sorted
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value))
}

export function utf8Bytes(value) {
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}

export function batchDigest(actions) {
  const payload = actions.map(({ id, tool, arguments: args, summary }) => ({
    id,
    tool,
    arguments: args,
    summary,
  }))
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`
}

export function textPreview(value, limit) {
  const text = typeof value === 'string' ? value : canonicalJson(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… (+${text.length - limit} chars)`
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function actionView(action) {
  return {
    id: action.id,
    tool: action.tool,
    arguments: cloneJson(action.arguments),
    ...(action.summary === undefined ? {} : { summary: action.summary }),
    status: action.status,
    ...(action.receipt === undefined ? {} : { receipt: cloneJson(action.receipt) }),
  }
}

function stateView(state) {
  const digest = batchDigest(state.actions)
  return {
    ok: true,
    outbox_id: state.id,
    label: state.label,
    phase: state.phase,
    digest,
    reviewed: state.reviewedDigest === digest,
    action_count: state.actions.length,
    actions: state.actions.map(actionView),
  }
}

export class OutboxLedger {
  #states = new WeakMap()
  #sequence = 0
  #maxActions
  #rejectDuplicateActions

  constructor({ maxActions, rejectDuplicateActions = true }) {
    this.#maxActions = maxActions
    this.#rejectDuplicateActions = rejectDuplicateActions
  }

  begin(owner, label) {
    const existing = this.#states.get(owner)
    if (existing !== undefined) {
      return {
        ok: false,
        code: 'outbox_already_open',
        message: `Outbox ${existing.id} is ${existing.phase}; review, commit, or discard it first.`,
        outbox: stateView(existing),
      }
    }
    this.#sequence += 1
    const state = {
      id: `outbox-${this.#sequence}`,
      label,
      phase: 'open',
      actions: [],
      nextActionSequence: 0,
      reviewedDigest: undefined,
    }
    this.#states.set(owner, state)
    return stateView(state)
  }

  stage(owner, action) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'Call action_outbox_begin first.' }
    }
    if (state.phase !== 'open') {
      return {
        ok: false,
        code: 'outbox_not_open',
        message: `Outbox ${state.id} is ${state.phase} and cannot accept new actions.`,
      }
    }
    if (state.actions.length >= this.#maxActions) {
      return {
        ok: false,
        code: 'outbox_full',
        message: `Outbox ${state.id} already contains the configured maximum of ${this.#maxActions} actions.`,
      }
    }
    if (this.#rejectDuplicateActions) {
      const argumentsJson = canonicalJson(action.arguments)
      const duplicate = state.actions.find(candidate => (
        candidate.tool === action.tool && canonicalJson(candidate.arguments) === argumentsJson
      ))
      if (duplicate !== undefined) {
        return {
          ok: false,
          code: 'duplicate_action',
          message: `The same "${action.tool}" call is already staged as ${duplicate.id}.`,
          duplicate_of: duplicate.id,
        }
      }
    }
    state.nextActionSequence += 1
    state.actions.push({
      id: `action-${state.nextActionSequence}`,
      tool: action.tool,
      arguments: cloneJson(action.arguments),
      ...(action.summary === undefined ? {} : { summary: action.summary }),
      ...(action.definition === undefined ? {} : { definition: action.definition }),
      status: 'pending',
    })
    state.reviewedDigest = undefined
    return stateView(state)
  }

  unstage(owner, actionId) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'Call action_outbox_begin first.' }
    }
    if (state.phase !== 'open') {
      return {
        ok: false,
        code: 'outbox_not_open',
        message: `Outbox ${state.id} is ${state.phase} and cannot remove actions.`,
      }
    }
    const index = state.actions.findIndex(action => action.id === actionId)
    if (index === -1) {
      return {
        ok: false,
        code: 'unknown_action',
        message: `Outbox ${state.id} has no action named "${actionId}".`,
      }
    }
    const [removed] = state.actions.splice(index, 1)
    state.reviewedDigest = undefined
    return {
      ...stateView(state),
      removed_action: actionView(removed),
    }
  }

  review(owner) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    }
    if (state.phase === 'open') state.reviewedDigest = batchDigest(state.actions)
    return stateView(state)
  }

  inspect(owner) {
    const state = this.#states.get(owner)
    return state === undefined
      ? { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
      : stateView(state)
  }

  reviewCandidate(owner) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    }
    if (state.phase !== 'open') {
      return {
        ok: false,
        code: 'outbox_not_open',
        message: `Outbox ${state.id} is ${state.phase} and cannot be reviewed for commit.`,
        outbox: stateView(state),
      }
    }
    return { ok: true, actions: [...state.actions] }
  }

  beginCommit(owner, expectedDigest) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    }
    if (state.phase !== 'open') {
      return {
        ok: false,
        code: 'outbox_not_open',
        message: `Outbox ${state.id} is ${state.phase}; a blocked outbox must be discarded.`,
        outbox: stateView(state),
      }
    }
    if (state.actions.length === 0) {
      return { ok: false, code: 'outbox_empty', message: `Outbox ${state.id} has no actions.` }
    }
    const actualDigest = batchDigest(state.actions)
    if (expectedDigest !== actualDigest) {
      return {
        ok: false,
        code: 'digest_mismatch',
        message: 'The outbox changed after review. Review it again and use the new digest.',
        expected_digest: expectedDigest,
        actual_digest: actualDigest,
      }
    }
    if (state.reviewedDigest !== actualDigest) {
      return {
        ok: false,
        code: 'review_required',
        message: 'Call action_outbox_review after the final batch change, then commit its digest.',
        actual_digest: actualDigest,
      }
    }
    state.phase = 'committing'
    return { ok: true, state, actions: [...state.actions] }
  }

  markSucceeded(owner, actionId, receipt) {
    const state = this.#states.get(owner)
    if (state === undefined || state.phase !== 'committing') return
    const action = state.actions.find(candidate => candidate.id === actionId)
    if (action === undefined) return
    action.status = 'succeeded'
    action.receipt = cloneJson(receipt)
  }

  block(owner, actionId, receipt) {
    const state = this.#states.get(owner)
    if (state === undefined || state.phase !== 'committing') return
    const action = state.actions.find(candidate => candidate.id === actionId)
    if (action !== undefined) {
      action.status = 'failed'
      action.receipt = cloneJson(receipt)
    }
    state.phase = 'blocked'
  }

  finish(owner) {
    const state = this.#states.get(owner)
    if (state === undefined || state.phase !== 'committing') {
      return { ok: false, code: 'commit_invariant', message: 'The outbox is not committing.' }
    }
    const receipt = {
      ok: true,
      outbox_id: state.id,
      phase: 'committed',
      digest: batchDigest(state.actions),
      action_count: state.actions.length,
      actions: state.actions.map(actionView),
    }
    this.#states.delete(owner)
    return receipt
  }

  discard(owner) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    }
    if (state.phase === 'committing') {
      return {
        ok: false,
        code: 'commit_in_progress',
        message: `Outbox ${state.id} is committing and cannot be discarded concurrently.`,
      }
    }
    this.#states.delete(owner)
    return {
      ok: true,
      outbox_id: state.id,
      phase: 'discarded',
      discarded_actions: state.actions.length,
      external_actions_executed: state.actions.filter(action => action.status === 'succeeded').length,
    }
  }
}

export function approvalReason(review, limit) {
  if (!review.ok) return 'Commit the currently reviewed action outbox.'
  const lines = [
    `Commit ${review.outbox_id} with ${review.action_count} staged action(s)?`,
    `Digest: ${review.digest}`,
  ]
  for (const action of review.actions) {
    const summary = action.summary === undefined ? '' : ` — ${action.summary}`
    lines.push(`${action.id}: ${action.tool}${summary}`)
  }
  lines.push('Exact arguments:')
  for (const action of review.actions) {
    lines.push(`  arguments: ${canonicalJson(action.arguments)}`)
  }
  return textPreview(lines.join('\n'), limit)
}

export function resultReceipt(result, previewChars) {
  const rendered = result.content
    .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
    .join('\n')
  return result.isError
    ? {
        ok: false,
        error: result.error.message,
        output_preview: textPreview(rendered, previewChars),
      }
    : {
        ok: true,
        output_preview: textPreview(rendered, previewChars),
      }
}
