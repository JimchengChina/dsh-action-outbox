import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

const FORMAT_VERSION = 1
const MAX_STATE_FILE_BYTES = 4 * 1024 * 1024

export function defaultStateFile() {
  const dshHome = process.env.DSH_HOME?.trim()
  const root = dshHome === undefined || dshHome.length === 0
    ? join(homedir(), '.dsh')
    : resolve(dshHome)
  return join(root, 'action-outbox', 'state.json')
}

function assertRegularFile(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`action-outbox: refusing non-regular state file ${path}`)
  }
  if (stat.size > MAX_STATE_FILE_BYTES) {
    throw new Error(`action-outbox: state file exceeds ${MAX_STATE_FILE_BYTES} bytes`)
  }
}

/**
 * Small synchronous store used at state-transition boundaries. Outboxes are
 * bounded and writes are deliberately completed before a side effect starts.
 */
export class JsonStateStore {
  constructor(path = defaultStateFile()) {
    this.path = resolve(path)
  }

  load() {
    if (!existsSync(this.path)) return { version: FORMAT_VERSION, states: [] }
    assertRegularFile(this.path)
    const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== FORMAT_VERSION
      || !Array.isArray(parsed.states)) {
      throw new Error(`action-outbox: unsupported or corrupt state file ${this.path}`)
    }
    return parsed
  }

  save(states) {
    const directory = dirname(this.path)
    const directoryExisted = existsSync(directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!directoryExisted) chmodSync(directory, 0o700)

    if (existsSync(this.path)) assertRegularFile(this.path)
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const payload = `${JSON.stringify({ version: FORMAT_VERSION, states })}\n`
    if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_FILE_BYTES) {
      throw new Error(`action-outbox: serialized state exceeds ${MAX_STATE_FILE_BYTES} bytes`)
    }

    let descriptor
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      writeFileSync(descriptor, payload, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.path)
      chmodSync(this.path, 0o600)
      const directoryDescriptor = openSync(directory, constants.O_RDONLY)
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      try { unlinkSync(temporary) } catch {}
      throw error
    }
  }
}
