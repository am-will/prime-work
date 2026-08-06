import { createReadStream, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SessionRecord, SessionStatus } from '../../../src/types/api'
import { strictJsonLines } from '../jsonl'
import { isRecord } from '../validation'
import { compactText, textFromContent, validTimestamp } from './transcript'

export type JsonRecord = Record<string, unknown>

export interface SessionMetadata extends SessionRecord { sessionName?: string }

function statusFrom(
  taskState: string | undefined,
  lifecycle: string | undefined,
  lastRole: string | undefined,
  stopReason: string | undefined,
): SessionStatus {
  if (lifecycle === 'crash') return 'failed'
  if (lifecycle === 'archived') return 'complete'
  if (taskState === 'completed') return 'complete'
  if (taskState === 'needs_input') return 'waiting'
  if (stopReason === 'error') return 'failed'
  if (lastRole === 'assistant' || lastRole === 'toolResult') return 'complete'
  if (lastRole === 'user') return 'idle'
  return 'unknown'
}

export function applyLiveMetadata(metadata: SessionMetadata, live: JsonRecord): void {
  if (live.workerState === 'failed') metadata.status = 'failed'
  else if (live.isStreaming === true || live.activity === 'working' || live.isCompacting === true) metadata.status = 'running'
  else if (live.lifecycle === 'archived') metadata.status = 'complete'
  else if (live.taskState === 'completed') metadata.status = 'complete'
  else if (live.taskState === 'needs_input') metadata.status = 'waiting'
  else metadata.status = 'idle'
  if (typeof live.sessionName === 'string' && live.sessionName.trim()) metadata.title = compactText(live.sessionName, 100)
  if (typeof live.thinkingLevel === 'string') metadata.thinkingLevel = live.thinkingLevel
  if (typeof live.rlmDepth === 'number' && Number.isInteger(live.rlmDepth) && live.rlmDepth >= 0) metadata.depth = live.rlmDepth
  if (typeof live.modified === 'string') {
    const liveModified = Date.parse(live.modified)
    const jsonlModified = Date.parse(metadata.updatedAt)
    if (Number.isFinite(liveModified) && (!Number.isFinite(jsonlModified) || liveModified > jsonlModified)) {
      metadata.updatedAt = new Date(liveModified).toISOString()
    }
  }
  if (isRecord(live.model)) {
    if (typeof live.model.id === 'string') metadata.model = live.model.id
    if (typeof live.model.provider === 'string') metadata.provider = live.model.provider
  }
}

export async function readSessionMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
  const fileStat = knownStat ?? await stat(filePath)
  if (fileStat.size > 256 * 1024 * 1024) throw new Error('Session file is too large')
  const fallbackCreated = fileStat.birthtime.toISOString()
  const fallbackUpdated = fileStat.mtime.toISOString()
  let id = basename(filePath, '.jsonl')
  let projectPath = ''
  let createdAt = fallbackCreated
  let updatedAt = fallbackUpdated
  let depth = 0
  let model: string | undefined
  let provider: string | undefined
  let thinkingLevel: string | undefined
  let sessionName: string | undefined
  let firstUser = ''
  let preview = ''
  let lifecycle: string | undefined
  let taskState: string | undefined
  let lastRole: string | undefined
  let stopReason: string | undefined

  let metadataRecords = 0
  for await (const line of strictJsonLines(createReadStream(filePath))) {
    if (!line) continue
    if (++metadataRecords > 200_000) throw new Error('Session file has too many records')
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    if (!isRecord(value)) continue
    updatedAt = validTimestamp(value.timestamp, updatedAt)
    if (value.type === 'session') {
      if (typeof value.id === 'string') id = value.id
      if (typeof value.cwd === 'string') projectPath = value.cwd
      createdAt = validTimestamp(value.timestamp, createdAt)
      if (typeof value.rlmDepth === 'number' && Number.isInteger(value.rlmDepth) && value.rlmDepth >= 0) depth = value.rlmDepth
      else if (typeof value.parentSession === 'string') depth = 1
    } else if (value.type === 'model_change') {
      if (typeof value.modelId === 'string') model = value.modelId
      if (typeof value.provider === 'string') provider = value.provider
    } else if (value.type === 'thinking_level_change' && typeof value.thinkingLevel === 'string') thinkingLevel = value.thinkingLevel
    else if (value.type === 'session_info' && typeof value.name === 'string') sessionName = value.name
    else if (value.type === 'session_state' && isRecord(value.state) && typeof value.state.status === 'string') lifecycle = value.state.status
    else if (value.type === 'agent_status' && isRecord(value.status) && typeof value.status.taskState === 'string') taskState = value.status.taskState
    else if (value.type === 'message' && isRecord(value.message)) {
      const message = value.message
      if (typeof message.role === 'string') lastRole = message.role
      if (typeof message.stopReason === 'string') stopReason = message.stopReason
      const text = textFromContent(message.content, 4_096)
      if (message.role === 'user' && !firstUser && text) firstUser = text
      if ((message.role === 'assistant' || message.role === 'user') && text) preview = text
    }
  }
  const title = compactText(sessionName || firstUser, 100) || 'Untitled session'
  return {
    id,
    filePath,
    projectPath,
    title,
    createdAt,
    updatedAt,
    status: statusFrom(taskState, lifecycle, lastRole, stopReason),
    model,
    provider,
    thinkingLevel,
    depth,
    pinned: false,
    unread: false,
    preview: compactText(preview || firstUser),
    sessionName,
  }
}
