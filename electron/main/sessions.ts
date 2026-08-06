import { watch, type FSWatcher, type Stats } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { SessionChangeEvent, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { queueDaemonFollowUp } from './agent-daemon'
import { runProcess } from './process-utils'
import { SessionMetadataCatalog } from './sessions/catalog'
import { readSessionMetadata, type SessionMetadata } from './sessions/metadata'
import { readTranscript } from './sessions/transcript'
import type { JsonStateStore } from './store'
import { isPathWithin, isRecord, requireBoolean, requireId, requireString } from './validation'

interface RuntimeSessionState { isStreaming: boolean }

const MAX_SESSION_FILES = 5_000

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export class SessionService {
  readonly sessionRoot = join(homedir(), '.prime', 'agent', 'sessions')
  private runtimeForSession: (filePath: string) => RuntimeSessionState | undefined = () => undefined
  private stopRuntimeForSession: (filePath: string) => Promise<void> = async () => undefined
  private renameRuntimeSession: (filePath: string, title: string) => Promise<boolean> = async () => false
  private readonly catalog: SessionMetadataCatalog
  private readonly changeListeners = new Set<(event: SessionChangeEvent) => void>()
  private sessionWatcher: FSWatcher | null = null
  private watcherRetry: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null
  private readonly changedNames = new Set<string>()
  private catalogOnlyChange = false

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: string | null,
    maxSessionFiles = MAX_SESSION_FILES,
  ) {
    this.catalog = new SessionMetadataCatalog(
      () => this.sessionRoot,
      primeAgentPath,
      maxSessionFiles,
      (filePath, knownStat) => this.readMetadata(filePath, knownStat),
    )
  }

  bindRuntimeHooks(hooks: {
    get(filePath: string): RuntimeSessionState | undefined
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  onDidChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    this.startWatcher()
    return () => {
      this.changeListeners.delete(listener)
      if (!this.changeListeners.size) this.stopWatcher()
    }
  }

  async list(projectPath?: string, includeArchivedValue: unknown = false): Promise<SessionRecord[]> {
    const includeArchived = requireBoolean(includeArchivedValue, 'includeArchived')
    const project = projectPath ? resolve(requireString(projectPath, 'projectPath', { min: 1, max: 4096 })) : undefined
    const sessions = await this.catalog.all()
    const archived = new Set(this.store.snapshot().archivedSessions.map((path) => resolve(path)))
    const records: SessionRecord[] = []
    for (const original of sessions) {
      const metadata = { ...original }
      const isArchived = archived.has(resolve(metadata.filePath))
      if ((isArchived && !includeArchived) || (project && resolve(metadata.projectPath) !== project)) continue
      const runtime = this.runtimeForSession(metadata.filePath)
      if (runtime) metadata.status = runtime.isStreaming ? 'running' : 'idle'
      const { sessionName: _sessionName, ...record } = metadata
      records.push({ ...record, archived: isArchived })
    }
    return records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || comparePaths(a.filePath, b.filePath))
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  async read(filePath: string): Promise<TranscriptMessage[]> {
    const safePath = await this.requireSessionPath(filePath)
    return readTranscript(safePath, this.runtimeForSession(safePath)?.isStreaming === true)
  }

  async followUp(filePath: string, message: string): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const safeMessage = requireString(message, 'message', { min: 1, max: 64 * 1024 })
    if (!this.primeAgentPath) throw new Error('Prime Agent executable was not found')

    const catalog = await runProcess(this.primeAgentPath, ['list', '--json'], { timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024 })
    if (catalog.code !== 0 || catalog.timedOut || catalog.outputExceeded) throw new Error('Prime Work could not inspect active Prime Agent sessions')
    let parsed: unknown
    try { parsed = JSON.parse(catalog.stdout) } catch { throw new Error('Prime Agent returned an invalid active-session catalog') }
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)
      || parsed.sessions.length > MAX_SESSION_FILES * 4) {
      throw new Error('Prime Agent returned an invalid active-session catalog')
    }

    let active: Record<string, unknown> | undefined
    for (const value of parsed.sessions) {
      if (!isRecord(value) || value.lifecycle !== 'live' || value.isSessionActive !== true
        || typeof value.sessionFile !== 'string' || value.sessionFile.length > 4_096) continue
      let candidate: string
      try { candidate = await realpath(value.sessionFile) } catch { continue }
      if (candidate === safePath) { active = value; break }
    }
    if (!active) return false
    const activeSessionId = requireId(active.activeSessionId ?? active.id, 'activeSessionId')
    if (activeSessionId.startsWith('-')) throw new Error('Prime Agent returned an invalid active session identifier')

    const status = await runProcess(this.primeAgentPath, ['status', '--json'], { timeoutMs: 15_000, maxBytes: 1024 * 1024 })
    if (status.code !== 0 || status.timedOut || status.outputExceeded) throw new Error('Prime Work could not inspect the Prime Agent daemon')
    let statuses: unknown
    try { statuses = JSON.parse(status.stdout) } catch { throw new Error('Prime Agent returned an invalid daemon status') }
    if (!Array.isArray(statuses) || statuses.length > 64) throw new Error('Prime Agent returned an invalid daemon status')
    const current = statuses.find((value) => isRecord(value) && value.status === 'current' && value.isDefault === true)
    if (!isRecord(current) || typeof current.socketPath !== 'string') throw new Error('Prime Agent did not report its active daemon socket')
    await queueDaemonFollowUp(current.socketPath, activeSessionId, safeMessage)
    return true
  }

  async rename(filePath: string, title: string): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const safeTitle = requireString(title, 'title', { min: 1, max: 200, trim: true })
    if (safeTitle.startsWith('-') || /[\r\n]/.test(safeTitle)) throw new TypeError('title contains invalid characters')
    if (await this.renameRuntimeSession(safePath, safeTitle)) return true
    if (!this.primeAgentPath) return false
    const metadata = await this.readMetadata(safePath)
    const result = await runProcess(this.primeAgentPath, ['rename', metadata.id, safeTitle, '--json'], { timeoutMs: 30_000 })
    return result.code === 0
  }

  async archive(filePath: string, archivedValue: unknown = true): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const archived = requireBoolean(archivedValue, 'archived')
    if (archived) await this.stopRuntimeForSession(safePath)
    await this.store.update((state) => {
      state.archivedSessions = state.archivedSessions.filter((path) => resolve(path) !== resolve(safePath))
      if (archived) state.archivedSessions.push(safePath)
    })
    return true
  }

  async requireSessionPath(value: unknown): Promise<string> {
    const requested = requireString(value, 'filePath', { min: 1, max: 4096 })
    const root = await realpath(this.sessionRoot)
    const path = await realpath(requested)
    if (!isPathWithin(root, path) || !path.endsWith('.jsonl')) throw new TypeError('Session path is outside the Prime session directory')
    return path
  }

  private startWatcher(): void {
    if (this.sessionWatcher || this.watcherRetry || !this.changeListeners.size) return
    try {
      const watcher = watch(this.sessionRoot, { persistent: false }, (_eventType, filename) => {
        this.queueSessionChange(filename)
      })
      this.sessionWatcher = watcher
      watcher.on('error', () => {
        if (this.sessionWatcher !== watcher) return
        watcher.close()
        this.sessionWatcher = null
        this.queueSessionChange(null)
        this.scheduleWatcherRetry()
      })
    } catch {
      this.scheduleWatcherRetry()
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetry || !this.changeListeners.size) return
    this.watcherRetry = setTimeout(() => {
      this.watcherRetry = null
      this.startWatcher()
    }, 1_000)
    this.watcherRetry.unref()
  }

  private stopWatcher(): void {
    this.sessionWatcher?.close()
    this.sessionWatcher = null
    if (this.watcherRetry) clearTimeout(this.watcherRetry)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.watcherRetry = null
    this.changeTimer = null
    this.changedNames.clear()
    this.catalogOnlyChange = false
  }

  private queueSessionChange(filename: string | Buffer | null): void {
    const name = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : ''
    if (!name || basename(name) !== name || name.startsWith('.') || !name.endsWith('.jsonl')) {
      this.catalogOnlyChange = true
    } else if (this.changedNames.size < 256) {
      this.changedNames.add(name)
    } else {
      this.catalogOnlyChange = true
    }
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null
        void this.flushSessionChanges()
      }, 120)
      this.changeTimer.unref()
    }
  }

  private async flushSessionChanges(): Promise<void> {
    const names = [...this.changedNames]
    let catalogOnly = this.catalogOnlyChange
    this.changedNames.clear()
    this.catalogOnlyChange = false
    this.catalog.invalidateLiveCatalog()
    const paths = (await Promise.all(names.map(async (name) => {
      try { return await this.requireSessionPath(join(this.sessionRoot, name)) } catch { return null }
    }))).filter((path): path is string => path !== null)
    if (paths.length !== names.length) catalogOnly = true
    if (!this.changeListeners.size) return
    for (const filePath of paths) this.emitChange({ filePath })
    if (catalogOnly) this.emitChange({})
  }

  private emitChange(event: SessionChangeEvent): void {
    for (const listener of this.changeListeners) {
      try { listener(event) } catch { /* A renderer listener cannot break session watching. */ }
    }
  }

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    return readSessionMetadata(filePath, knownStat)
  }
}
