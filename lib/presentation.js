const TITLES = Object.freeze({
  begin: 'Open action outbox',
  stage: 'Stage external action',
  unstage: 'Remove staged action',
  replace: 'Edit staged action',
  review: 'Review action outbox',
  commit: 'Commit reviewed actions',
  discard: 'Discard action outbox',
})

const KINDS = Object.freeze({
  begin: 'edit',
  stage: 'edit',
  unstage: 'delete',
  replace: 'edit',
  review: 'read',
  commit: 'execute',
  discard: 'delete',
})

function salientInput(operation, args) {
  if (operation === 'begin') return args.label
  if (operation === 'stage') {
    return {
      tool: args.tool,
      arguments: args.arguments,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
    }
  }
  if (operation === 'unstage') return args.action_id
  if (operation === 'replace') return {
    action_id: args.action_id,
    ...(args.tool === undefined ? {} : { tool: args.tool }),
    ...(args.arguments === undefined ? {} : { arguments: args.arguments }),
    ...(args.summary === undefined ? {} : { summary: args.summary }),
  }
  if (operation === 'commit') return args.expected_digest
  return undefined
}

export function presentationMeta(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const keys = ['ok', 'code', 'phase', 'outbox_id', 'action_count', 'reviewed']
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}

export function outboxPresentation(operation) {
  const title = TITLES[operation]
  if (title === undefined) throw new TypeError(`unknown outbox presentation operation: ${operation}`)
  return {
    presentCall(args) {
      const rawInput = salientInput(operation, args)
      return {
        card: 'generic',
        title: operation === 'stage' && typeof args.tool === 'string'
          ? `Stage ${args.tool}`
          : title,
        kind: KINDS[operation],
        ...(rawInput === undefined ? {} : { rawInput }),
      }
    },
    presentResult(_args, result) {
      const meta = result.meta ?? {}
      const failed = result.isError || meta.ok === false
      const suffix = typeof meta.code === 'string' ? `: ${meta.code}` : ''
      return {
        card: 'generic',
        title: failed ? `${title} failed${suffix}` : title,
      }
    },
  }
}
