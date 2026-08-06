import type { Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '../process-utils'
import { isPathWithin, isRecord } from '../validation'
import { applyLiveMetadata, type JsonRecord, type SessionMetadata } from './metadata'

interface SessionFileCandidate { filePath: string; fileStat: Stats; fingerprint: string }

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function mapLimit<T, U>(values: readonly T[], limit: number, mapper: (value: T) => Promise<U | null>): Promise<U[]> {
  const result: U[] = []
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++]
      const mapped = await mapper(current)
      if (mapped !== null) result.push(mapped)
    }
  }))
  return result
}

export class SessionMetadataCatalog {
  private catalogCache: { expiresAt: number; revision: number; sessions: Map<string, JsonRecord> } | null = null
  private catalogRequest: { revision: number; promise: Promise<Map<string, JsonRecord>> } | null = null
  private catalogRevision = 0
  private sessionScanRequest: { revision: number; promise: Promise<SessionMetadata[]> } | null = null
  private readonly metadataCache = new Map<string, SessionMetadata>()
  private readonly metadataRequests = new Map<string, Promise<SessionMetadata>>()

  constructor(
    private readonly sessionRoot: () => string,
    private readonly primeAgentPath: string | null,
    private readonly maxSessionFiles: number,
    private readonly readMetadata: (filePath: string, knownStat?: Stats) => Promise<SessionMetadata>,
  ) {}

  invalidateLiveCatalog(): void {
    this.catalogRevision += 1
    this.catalogCache = null
  }

  async all(): Promise<SessionMetadata[]> {
    const revision = this.catalogRevision
    if (this.sessionScanRequest?.revision === revision) return this.sessionScanRequest.promise
    const request = { revision, promise: this.scan(revision) }
    this.sessionScanRequest = request
    try { return await request.promise } finally {
      if (this.sessionScanRequest === request) this.sessionScanRequest = null
    }
  }

  private async scan(revision: number): Promise<SessionMetadata[]> {
    let names: string[]
    let root: string
    try {
      [names, root] = await Promise.all([
        readdir(this.sessionRoot()).then((items) => items.filter((name) => name.endsWith('.jsonl') && !name.startsWith('.'))),
        realpath(this.sessionRoot()),
      ])
    } catch { return [] }

    const discovered = await mapLimit(names, 32, async (name): Promise<SessionFileCandidate | null> => {
      try {
        const filePath = await realpath(join(root, name))
        if (!isPathWithin(root, filePath)) return null
        const fileStat = await stat(filePath)
        if (!fileStat.isFile()) return null
        return { filePath, fileStat, fingerprint: `${filePath}\0${fileStat.mtimeMs}\0${fileStat.size}` }
      } catch { return null }
    })
    const byCanonicalPath = new Map<string, SessionFileCandidate>()
    for (const candidate of discovered) byCanonicalPath.set(candidate.filePath, candidate)
    const selected = [...byCanonicalPath.values()]
      .sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs || comparePaths(a.filePath, b.filePath))
      .slice(0, this.maxSessionFiles)
    if (this.catalogRevision === revision) {
      const activeFingerprints = new Set(selected.map((candidate) => candidate.fingerprint))
      for (const fingerprint of this.metadataCache.keys()) {
        if (!activeFingerprints.has(fingerprint)) this.metadataCache.delete(fingerprint)
      }
    }

    const catalogPromise = this.liveCatalog()
    const metadata = await mapLimit(selected, 6, async (candidate) => {
      try { return await this.cachedMetadata(candidate, revision) } catch { return null }
    })
    const catalog = await catalogPromise
    return metadata.map((original) => {
      const item = { ...original }
      const live = catalog.get(item.filePath)
      if (live) applyLiveMetadata(item, live)
      return item
    })
  }

  private async cachedMetadata(candidate: SessionFileCandidate, revision: number): Promise<SessionMetadata> {
    const cached = this.metadataCache.get(candidate.fingerprint)
    if (cached) return { ...cached }
    const inFlight = this.metadataRequests.get(candidate.fingerprint)
    if (inFlight) return { ...await inFlight }
    const request = this.readMetadata(candidate.filePath, candidate.fileStat)
    this.metadataRequests.set(candidate.fingerprint, request)
    try {
      const metadata = await request
      const current = await stat(candidate.filePath)
      if (this.catalogRevision === revision
        && current.mtimeMs === candidate.fileStat.mtimeMs && current.size === candidate.fileStat.size) {
        this.metadataCache.set(candidate.fingerprint, metadata)
      }
      return { ...metadata }
    } finally {
      if (this.metadataRequests.get(candidate.fingerprint) === request) this.metadataRequests.delete(candidate.fingerprint)
    }
  }

  private async liveCatalog(): Promise<Map<string, JsonRecord>> {
    if (!this.primeAgentPath) return new Map()
    const revision = this.catalogRevision
    if (this.catalogCache && this.catalogCache.revision === revision && this.catalogCache.expiresAt > Date.now()) {
      return this.catalogCache.sessions
    }
    if (this.catalogRequest?.revision === revision) return this.catalogRequest.promise
    const request = {
      revision,
      promise: (async () => {
        const sessions = new Map<string, JsonRecord>()
        try {
          const result = await runProcess(this.primeAgentPath!, ['list', '--all', '--json'], { timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024 })
          if (result.code === 0) {
            const parsed: unknown = JSON.parse(result.stdout)
            if (isRecord(parsed) && Array.isArray(parsed.sessions)
              && parsed.sessions.length <= this.maxSessionFiles * 4) {
              await mapLimit(parsed.sessions, 32, async (raw) => {
                if (!isRecord(raw) || typeof raw.sessionFile !== 'string'
                  || raw.sessionFile.length > 4_096 || !isAbsolute(raw.sessionFile)) return null
                try {
                  sessions.set(await realpath(raw.sessionFile), raw)
                  return true
                } catch { return null }
              })
            }
          }
        } catch { /* JSONL remains authoritative when the live catalog is unavailable. */ }
        if (this.catalogRevision === revision) {
          this.catalogCache = { expiresAt: Date.now() + 2_000, revision, sessions }
        }
        return sessions
      })(),
    }
    this.catalogRequest = request
    try { return await request.promise } finally {
      if (this.catalogRequest === request) this.catalogRequest = null
    }
  }
}
