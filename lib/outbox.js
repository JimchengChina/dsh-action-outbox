import { createHash, randomBytes } from 'node:crypto'

export const DEFAULT_CONFIG = Object.freeze({
  include: Object.freeze(['*']),
  exclude: Object.freeze([]),
  enforce: Object.freeze([]),
  requireApproval: true,
  rejectDuplicateActions: true,
  persistPending: true,
  stateFile: '',
  maxPendingMs: 30 * 60 * 1000,
  maxActions: 20,
  maxArgumentBytes: 64 * 1024,
  resultPreviewChars: 2_000,
  approvalPreviewChars: 4_000,
})

export const INTERNAL_TOOLS = Object.freeze(new Set([
  'action_outbox_begin',
  'action_outbox_stage',
  'action_outbox_unstage',
  'action_outbox_replace',
  'action_outbox_review',
  'action_outbox_commit',
  'action_outbox_discard',
  'run_code',
]))

const EDITABLE_PHASES = new Set(['open', 'needs_reapproval'])
const RESTORABLE_PHASES = new Set([
  'open', 'needs_reapproval', 'committing', 'blocked', 'recovery_required', 'expired',
])
const ACTION_STATUSES = new Set(['pending', 'succeeded', 'failed', 'ambiguous'])

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

function assertNonnegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`action-outbox: \`${field}\` must be a non-negative safe integer`)
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
  if (input.stateFile !== undefined && typeof input.stateFile !== 'string') {
    throw new TypeError('action-outbox: `stateFile` must be a string')
  }
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
    persistPending: assertBoolean(
      input.persistPending ?? DEFAULT_CONFIG.persistPending,
      'persistPending',
    ),
    stateFile: input.stateFile ?? DEFAULT_CONFIG.stateFile,
    maxPendingMs: assertNonnegativeSafeInteger(
      input.maxPendingMs ?? DEFAULT_CONFIG.maxPendingMs,
      'maxPendingMs',
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

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function utf8Bytes(value) {
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}

export function toolFingerprint(definition) {
  return sha256(canonicalJson({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output_schema: definition.output?.schema,
    timeout_ms: definition.timeoutMs,
  }))
}

export function toolSource(definition) {
  for (const field of ['source', 'provider', 'plugin']) {
    if (typeof definition[field] === 'string' && definition[field].length > 0) {
      return definition[field]
    }
  }
  return 'DSH live tool registry'
}

function actionDigestPayload(action) {
  return {
    id: action.id,
    tool: action.tool,
    arguments: action.arguments,
    ...(action.summary === undefined ? {} : { summary: action.summary }),
    ...(action.definitionFingerprint === undefined
      ? {}
      : { tool_fingerprint: action.definitionFingerprint }),
  }
}

export function actionDigest(action) {
  return sha256(canonicalJson(actionDigestPayload(action)))
}

export function batchDigest(actions) {
  return sha256(canonicalJson(actions.map(actionDigestPayload)))
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
    tool_source: action.toolSource ?? 'DSH live tool registry',
    tool_fingerprint: action.definitionFingerprint ?? null,
    arguments: cloneJson(action.arguments),
    canonical_arguments: canonicalJson(action.arguments),
    argument_bytes: utf8Bytes(action.arguments),
    action_digest: actionDigest(action),
    ...(action.summary === undefined ? {} : { summary: action.summary }),
    status: action.status,
    ...(action.receipt === undefined ? {} : { receipt: cloneJson(action.receipt) }),
  }
}

function stateView(state) {
  const digest = batchDigest(state.actions)
  const reviewed = state.reviewedDigest === digest && state.reviewNonce !== undefined
  return {
    ok: true,
    outbox_id: state.id,
    owner_id: typeof state.ownerId === 'string' ? state.ownerId : null,
    owner: cloneJson(state.ownerBinding ?? {}),
    label: state.label,
    phase: state.phase,
    created_at: new Date(state.createdAt).toISOString(),
    expires_at: state.expiresAt === undefined ? null : new Date(state.expiresAt).toISOString(),
    digest,
    reviewed,
    approval_nonce: reviewed ? state.reviewNonce : null,
    review_requires_full_ack: reviewed && state.reviewRequiresAcknowledgement === true,
    review_acknowledged: reviewed && state.reviewAcknowledgedAt !== undefined,
    review_acknowledged_at: state.reviewAcknowledgedAt === undefined
      ? null
      : new Date(state.reviewAcknowledgedAt).toISOString(),
    action_count: state.actions.length,
    actions: state.actions.map(actionView),
    ...(state.recoveryNotice === undefined ? {} : { recovery_notice: state.recoveryNotice }),
  }
}

function newNonce() {
  return `approve_${randomBytes(24).toString('base64url')}`
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

function assertRestoredState(ownerId, raw) {
  const outboxSequence = typeof raw?.id === 'string'
    ? Number.parseInt(raw.id.slice('outbox-'.length), 10)
    : Number.NaN
  if (raw === null || typeof raw !== 'object' || typeof ownerId !== 'string'
    || typeof raw.id !== 'string' || !/^outbox-[1-9]\d*$/.test(raw.id)
    || !Number.isSafeInteger(outboxSequence) || outboxSequence < 1
    || typeof raw.label !== 'string'
    || !RESTORABLE_PHASES.has(raw.phase) || !validTimestamp(raw.createdAt)
    || (raw.expiresAt !== undefined && !validTimestamp(raw.expiresAt))
    || !Array.isArray(raw.actions)) {
    throw new Error('action-outbox: corrupt persisted outbox state')
  }
  const seenActions = new Set()
  let maximumActionSequence = 0
  const actions = raw.actions.map(action => {
    const actionSequence = typeof action?.id === 'string'
      ? Number.parseInt(action.id.slice('action-'.length), 10)
      : Number.NaN
    if (action === null || typeof action !== 'object' || typeof action.id !== 'string'
      || !/^action-[1-9]\d*$/.test(action.id) || seenActions.has(action.id)
      || !Number.isSafeInteger(actionSequence) || actionSequence < 1
      || typeof action.tool !== 'string' || action.arguments === undefined
      || !ACTION_STATUSES.has(action.status)) {
      throw new Error('action-outbox: corrupt persisted action')
    }
    seenActions.add(action.id)
    maximumActionSequence = Math.max(maximumActionSequence, actionSequence)
    return {
      id: action.id,
      tool: action.tool,
      arguments: cloneJson(action.arguments),
      ...(typeof action.summary === 'string' ? { summary: action.summary } : {}),
      ...(typeof action.definitionFingerprint === 'string'
        ? { definitionFingerprint: action.definitionFingerprint }
        : {}),
      ...(typeof action.toolSource === 'string' ? { toolSource: action.toolSource } : {}),
      status: action.status,
      ...(action.receipt === undefined ? {} : { receipt: cloneJson(action.receipt) }),
    }
  })
  return {
    ownerId,
    ownerBinding: raw.ownerBinding !== null && typeof raw.ownerBinding === 'object'
      ? cloneJson(raw.ownerBinding)
      : { owner_id: ownerId },
    id: raw.id,
    label: raw.label,
    phase: raw.phase,
    actions,
    nextActionSequence: Number.isSafeInteger(raw.nextActionSequence)
      && raw.nextActionSequence >= maximumActionSequence
      ? raw.nextActionSequence
      : maximumActionSequence,
    reviewedDigest: undefined,
    reviewNonce: undefined,
    reviewRequiresAcknowledgement: true,
    reviewAcknowledgedAt: undefined,
    createdAt: raw.createdAt,
    ...(validTimestamp(raw.expiresAt) ? { expiresAt: raw.expiresAt } : {}),
    ...(typeof raw.recoveryNotice === 'string' ? { recoveryNotice: raw.recoveryNotice } : {}),
  }
}

export class OutboxLedger {
  #states = new Map()
  #sequence = 0
  #maxActions
  #rejectDuplicateActions
  #maxPendingMs
  #now
  #store

  constructor({
    maxActions,
    rejectDuplicateActions = true,
    maxPendingMs = DEFAULT_CONFIG.maxPendingMs,
    now = Date.now,
    store,
  }) {
    this.#maxActions = maxActions
    this.#rejectDuplicateActions = rejectDuplicateActions
    this.#maxPendingMs = maxPendingMs
    this.#now = now
    this.#store = store
    if (store !== undefined) this.#restore(store.load())
  }

  #restore(snapshot) {
    const seenOwners = new Set()
    for (const record of snapshot.states) {
      if (record === null || typeof record !== 'object' || typeof record.ownerId !== 'string') {
        throw new Error('action-outbox: corrupt persisted owner record')
      }
      if (seenOwners.has(record.ownerId)) {
        throw new Error('action-outbox: duplicate persisted owner record')
      }
      seenOwners.add(record.ownerId)
      const state = assertRestoredState(record.ownerId, record.state)
      if (state.actions.length > this.#maxActions) {
        throw new Error('action-outbox: persisted outbox exceeds configured maxActions')
      }
      state.ownerBinding = { ...state.ownerBinding, owner_id: record.ownerId }
      const sequence = Number.parseInt(state.id.replace(/^outbox-/, ''), 10)
      if (Number.isSafeInteger(sequence)) this.#sequence = Math.max(this.#sequence, sequence)
      if (state.phase === 'open' || state.phase === 'needs_reapproval') {
        state.phase = 'needs_reapproval'
        state.recoveryNotice = 'Restored after restart. Live tool identity, schema, policy, and approval must be checked again.'
      } else if (state.phase === 'committing') {
        state.phase = 'recovery_required'
        for (const action of state.actions) {
          if (action.status === 'pending') action.status = 'ambiguous'
        }
        state.recoveryNotice = 'The process stopped during commit. Ambiguous actions will not be retried automatically.'
      }
      this.#states.set(record.ownerId, state)
    }
    this.#persist()
  }

  #serializeState(state) {
    return {
      id: state.id,
      label: state.label,
      phase: state.phase,
      ownerBinding: cloneJson(state.ownerBinding ?? {}),
      actions: state.actions.map(action => ({
        id: action.id,
        tool: action.tool,
        arguments: cloneJson(action.arguments),
        ...(action.summary === undefined ? {} : { summary: action.summary }),
        ...(action.definitionFingerprint === undefined
          ? {}
          : { definitionFingerprint: action.definitionFingerprint }),
        ...(action.toolSource === undefined ? {} : { toolSource: action.toolSource }),
        status: action.status,
        ...(action.receipt === undefined ? {} : { receipt: cloneJson(action.receipt) }),
      })),
      nextActionSequence: state.nextActionSequence,
      createdAt: state.createdAt,
      ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
      ...(state.recoveryNotice === undefined ? {} : { recoveryNotice: state.recoveryNotice }),
    }
  }

  #persist() {
    if (this.#store === undefined) return
    const states = []
    for (const [ownerId, state] of this.#states) {
      if (typeof ownerId !== 'string') continue
      states.push({ ownerId, state: this.#serializeState(state) })
    }
    this.#store.save(states)
  }

  #expire(state) {
    if (EDITABLE_PHASES.has(state.phase) && state.expiresAt !== undefined
      && this.#now() >= state.expiresAt) {
      state.phase = 'expired'
      state.reviewedDigest = undefined
      state.reviewNonce = undefined
      state.reviewAcknowledgedAt = undefined
      this.#persist()
    }
    return state
  }

  #invalidateReview(state) {
    state.reviewedDigest = undefined
    state.reviewNonce = undefined
    state.reviewRequiresAcknowledgement = false
    state.reviewAcknowledgedAt = undefined
  }

  begin(owner, label, ownerBinding = {}) {
    let existing = this.#states.get(owner)
    if (existing !== undefined && this.#expire(existing).phase === 'expired') {
      this.#states.delete(owner)
      existing = undefined
    }
    if (existing !== undefined) {
      return {
        ok: false,
        code: 'outbox_already_open',
        message: `Outbox ${existing.id} is ${existing.phase}; review, commit, or discard it first.`,
        outbox: stateView(existing),
      }
    }
    this.#sequence += 1
    const createdAt = this.#now()
    const state = {
      ownerId: owner,
      ownerBinding: cloneJson(ownerBinding),
      id: `outbox-${this.#sequence}`,
      label,
      phase: 'open',
      actions: [],
      nextActionSequence: 0,
      reviewedDigest: undefined,
      reviewNonce: undefined,
      reviewRequiresAcknowledgement: false,
      reviewAcknowledgedAt: undefined,
      createdAt,
      expiresAt: this.#maxPendingMs === 0 ? undefined : createdAt + this.#maxPendingMs,
    }
    this.#states.set(owner, state)
    this.#persist()
    return stateView(state)
  }

  stage(owner, action) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'Call action_outbox_begin first.' }
    }
    this.#expire(state)
    if (!EDITABLE_PHASES.has(state.phase)) {
      return {
        ok: false,
        code: state.phase === 'expired' ? 'outbox_expired' : 'outbox_not_open',
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
      ...(action.definitionFingerprint === undefined
        ? {}
        : { definitionFingerprint: action.definitionFingerprint }),
      ...(action.toolSource === undefined ? {} : { toolSource: action.toolSource }),
      status: 'pending',
    })
    this.#invalidateReview(state)
    this.#persist()
    return stateView(state)
  }

  unstage(owner, actionId) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'Call action_outbox_begin first.' }
    }
    this.#expire(state)
    if (!EDITABLE_PHASES.has(state.phase)) {
      return {
        ok: false,
        code: state.phase === 'expired' ? 'outbox_expired' : 'outbox_not_open',
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
    this.#invalidateReview(state)
    this.#persist()
    return { ...stateView(state), removed_action: actionView(removed) }
  }

  replace(owner, actionId, replacement, guard = {}) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'Call action_outbox_begin first.' }
    }
    this.#expire(state)
    if (!EDITABLE_PHASES.has(state.phase)) {
      return {
        ok: false,
        code: state.phase === 'expired' ? 'outbox_expired' : 'outbox_not_open',
        message: `Outbox ${state.id} is ${state.phase} and cannot edit actions.`,
      }
    }
    const digest = batchDigest(state.actions)
    if (guard.expectedDigest !== undefined && guard.expectedDigest !== digest) {
      return { ok: false, code: 'digest_mismatch', message: 'The batch changed; refresh before editing.', actual_digest: digest }
    }
    if (state.reviewNonce !== undefined && guard.approvalNonce !== undefined
      && guard.approvalNonce !== state.reviewNonce) {
      return { ok: false, code: 'approval_nonce_mismatch', message: 'The review nonce is stale; refresh before editing.' }
    }
    const action = state.actions.find(candidate => candidate.id === actionId)
    if (action === undefined) {
      return { ok: false, code: 'unknown_action', message: `Outbox ${state.id} has no action named "${actionId}".` }
    }
    const hasChange = ['tool', 'arguments', 'summary'].some(key => Object.hasOwn(replacement, key))
    if (!hasChange) return { ok: false, code: 'no_changes', message: 'Provide tool, arguments, or summary.' }

    if (this.#rejectDuplicateActions) {
      const nextTool = Object.hasOwn(replacement, 'tool') ? replacement.tool : action.tool
      const nextArguments = Object.hasOwn(replacement, 'arguments')
        ? replacement.arguments
        : action.arguments
      const argumentsJson = canonicalJson(nextArguments)
      const duplicate = state.actions.find(candidate => candidate.id !== actionId
        && candidate.tool === nextTool && canonicalJson(candidate.arguments) === argumentsJson)
      if (duplicate !== undefined) {
        return {
          ok: false,
          code: 'duplicate_action',
          message: `The same "${nextTool}" call is already staged as ${duplicate.id}.`,
          duplicate_of: duplicate.id,
        }
      }
    }

    if (Object.hasOwn(replacement, 'tool')) action.tool = replacement.tool
    if (Object.hasOwn(replacement, 'arguments')) action.arguments = cloneJson(replacement.arguments)
    if (Object.hasOwn(replacement, 'summary')) {
      if (replacement.summary === undefined) delete action.summary
      else action.summary = replacement.summary
    }
    if (replacement.definition !== undefined) action.definition = replacement.definition
    else delete action.definition
    if (replacement.definitionFingerprint !== undefined) {
      action.definitionFingerprint = replacement.definitionFingerprint
    } else {
      delete action.definitionFingerprint
    }
    if (replacement.toolSource !== undefined) action.toolSource = replacement.toolSource
    else delete action.toolSource
    action.status = 'pending'
    delete action.receipt
    this.#invalidateReview(state)
    this.#persist()
    return { ...stateView(state), replaced_action_id: actionId, requires_new_review: true }
  }

  review(owner, options = {}) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    }
    this.#expire(state)
    if (!EDITABLE_PHASES.has(state.phase)) return stateView(state)
    if (options.definitions !== undefined) {
      for (const action of state.actions) {
        const definition = options.definitions.get(action.id)
        if (definition !== undefined) action.definition = definition
      }
    }
    state.phase = 'open'
    delete state.recoveryNotice
    state.reviewedDigest = batchDigest(state.actions)
    state.reviewNonce = newNonce()
    state.reviewRequiresAcknowledgement = options.requiresAcknowledgement === true
    state.reviewAcknowledgedAt = state.reviewRequiresAcknowledgement ? undefined : this.#now()
    this.#persist()
    return stateView(state)
  }

  requireFullAcknowledgement(owner, digest, nonce) {
    const state = this.#states.get(owner)
    if (state === undefined || state.reviewedDigest !== digest || state.reviewNonce !== nonce) {
      return { ok: false, code: 'stale_review', message: 'The review changed before visibility could be locked.' }
    }
    state.reviewRequiresAcknowledgement = true
    state.reviewAcknowledgedAt = undefined
    this.#persist()
    return stateView(state)
  }

  acknowledge(owner, digest, nonce) {
    const state = this.#states.get(owner)
    if (state === undefined) return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    this.#expire(state)
    const actualDigest = batchDigest(state.actions)
    if (state.phase !== 'open' || state.reviewedDigest !== actualDigest
      || digest !== actualDigest || state.reviewNonce !== nonce) {
      return { ok: false, code: 'stale_review', message: 'The batch or review changed. Review the current batch again.' }
    }
    state.reviewAcknowledgedAt = this.#now()
    this.#persist()
    return stateView(state)
  }

  inspect(owner) {
    const state = this.#states.get(owner)
    return state === undefined
      ? { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
      : stateView(this.#expire(state))
  }

  list() {
    return [...this.#states.values()].map(state => stateView(this.#expire(state)))
  }

  reviewCandidate(owner) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    }
    this.#expire(state)
    if (!EDITABLE_PHASES.has(state.phase)) {
      return {
        ok: false,
        code: state.phase === 'expired' ? 'outbox_expired' : 'outbox_not_open',
        message: `Outbox ${state.id} is ${state.phase} and cannot be reviewed for commit.`,
        outbox: stateView(state),
      }
    }
    return { ok: true, actions: [...state.actions] }
  }

  beginCommit(owner, expectedDigest, approvalNonce, { requireAcknowledgement = false } = {}) {
    const state = this.#states.get(owner)
    if (state === undefined) {
      return { ok: false, code: 'no_open_outbox', message: 'There is no active outbox.' }
    }
    this.#expire(state)
    if (state.phase !== 'open') {
      return {
        ok: false,
        code: state.phase === 'expired' ? 'outbox_expired' : 'outbox_not_open',
        message: `Outbox ${state.id} is ${state.phase}; it cannot be committed.`,
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
        message: 'The submitted digest is stale. If Review ran in Batch Review Inbox, chat cannot see its UI-only credentials: use “Next: copy exact commit prompt” in Inbox. Otherwise call action_outbox_review in chat and commit the digest and nonce returned by that tool call.',
        expected_digest: expectedDigest,
        actual_digest: actualDigest,
        target_actions_dispatched: 0,
      }
    }
    if (state.reviewedDigest !== actualDigest || state.reviewNonce === undefined) {
      return {
        ok: false,
        code: 'review_required',
        message: 'Call action_outbox_review after the final batch change, then commit its digest and nonce.',
        actual_digest: actualDigest,
      }
    }
    if (approvalNonce !== state.reviewNonce) {
      return {
        ok: false,
        code: 'approval_nonce_mismatch',
        message: 'The approval nonce is missing, stale, or already consumed. Review the batch again.',
      }
    }
    if (requireAcknowledgement && state.reviewRequiresAcknowledgement
      && state.reviewAcknowledgedAt === undefined) {
      return {
        ok: false,
        code: 'full_review_required',
        message: 'The approval preview is truncated. Open Batch Review Inbox and acknowledge the complete canonical JSON first.',
        outbox: stateView(state),
      }
    }
    state.phase = 'committing'
    state.reviewNonce = undefined
    state.reviewedDigest = undefined
    state.reviewAcknowledgedAt = undefined
    this.#persist()
    return { ok: true, state, actions: [...state.actions] }
  }

  markSucceeded(owner, actionId, receipt) {
    const state = this.#states.get(owner)
    if (state === undefined || state.phase !== 'committing') return
    const action = state.actions.find(candidate => candidate.id === actionId)
    if (action === undefined) return
    action.status = 'succeeded'
    action.receipt = cloneJson(receipt)
    this.#persist()
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
    this.#persist()
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
    this.#persist()
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
    this.#persist()
    return {
      ok: true,
      outbox_id: state.id,
      phase: 'discarded',
      discarded_actions: state.actions.length,
      external_actions_executed: state.actions.filter(action => action.status === 'succeeded').length,
      ambiguous_actions: state.actions.filter(action => action.status === 'ambiguous').length,
    }
  }
}

export function fullReviewText(review) {
  if (!review.ok) return 'Commit the currently reviewed action outbox.'
  const lines = [
    `Commit ${review.outbox_id} with ${review.action_count} staged action(s)?`,
    `Digest: ${review.digest}`,
    `Approval nonce: ${review.approval_nonce ?? 'missing'}`,
  ]
  for (const action of review.actions) {
    const summary = action.summary === undefined ? '' : ` — ${action.summary}`
    lines.push(`${action.id}: ${action.tool}${summary}`)
    lines.push(`  source: ${action.tool_source}`)
    lines.push(`  bytes: ${action.argument_bytes}`)
    lines.push(`  action hash: ${action.action_digest}`)
    lines.push(`  canonical arguments: ${action.canonical_arguments}`)
  }
  return lines.join('\n')
}

export function approvalPacket(review, limit, surface = 'Batch Review Inbox in the DSH sidebar') {
  const full = fullReviewText(review)
  if (full.length <= limit) return { reason: full, truncated: false, full_chars: full.length }
  const omitted = full.length - limit
  const visibilityLine = review.review_acknowledged
    ? `The complete canonical JSON was acknowledged in ${surface}; this modal remains a compact reminder.`
    : `Open ${surface} and acknowledge the complete canonical JSON before approval.`
  return {
    reason: [
      `⚠ Approval preview truncated; ${omitted} character(s) are not shown here.`,
      visibilityLine,
      `The digest covers the full batch: ${review.digest}`,
      '',
      full.slice(0, limit),
      `… (+${omitted} chars; this preview is not an authoritative review surface)`,
    ].join('\n'),
    truncated: true,
    full_chars: full.length,
  }
}

export function approvalReason(review, limit) {
  return approvalPacket(review, limit).reason
}

export function resultReceipt(result, previewChars, metadata = {}) {
  const rendered = result.content
    .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
    .join('\n')
  return result.isError
      ? {
        ok: false,
        error: result.error.message,
        ...(result.error.info === undefined ? {} : {
          error_code: result.error.info.code,
          error_name: result.error.info.name,
        }),
        output_preview: textPreview(rendered, previewChars),
        ...metadata,
      }
    : {
        ok: true,
        output_preview: textPreview(rendered, previewChars),
        ...metadata,
      }
}
