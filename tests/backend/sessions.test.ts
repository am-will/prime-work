import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../electron/main/sessions'
import { SessionMetadataCatalog } from '../../electron/main/sessions/catalog'
import type { SessionMetadata } from '../../electron/main/sessions/metadata'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(maxSessionFiles?: number): { root: string; project: string; service: SessionService } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new SessionService(store, null, maxSessionFiles)
  Object.defineProperty(service, 'sessionRoot', { value: root })
  return { root, project, service }
}

function writeSession(path: string, project: string, id: string, timestamp = '2025-01-01T00:00:00.000Z'): void {
  writeFileSync(path, [
    JSON.stringify({ type: 'session', id, cwd: project, timestamp }),
    JSON.stringify({ type: 'message', id: `${id}-message`, parentId: null, message: { role: 'user', content: id, timestamp } }),
    '',
  ].join('\n'))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

function metadata(filePath: string, projectPath: string, id: string): SessionMetadata {
  return {
    id,
    filePath,
    projectPath,
    title: id,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    status: 'idle',
    depth: 0,
    pinned: false,
    unread: false,
  }
}

describe('SessionService catalog scaling', () => {
  it('coalesces concurrent lists and reuses metadata by canonical path, mtime, and size', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'one.jsonl')
    writeSession(file, project, 'one')
    const readMetadata = vi.spyOn(service as unknown as { readMetadata(...args: unknown[]): Promise<unknown> }, 'readMetadata')

    const [all, archived, filtered] = await Promise.all([
      service.list(),
      service.list(undefined, true),
      service.list(project),
    ])
    expect(all).toHaveLength(1)
    expect(archived).toHaveLength(1)
    expect(filtered).toHaveLength(1)
    expect(readMetadata).toHaveBeenCalledTimes(1)

    await service.list()
    expect(readMetadata).toHaveBeenCalledTimes(1)
    writeSession(file, project, 'one-expanded', '2025-02-01T00:00:00.000Z')
    expect((await service.list())[0]?.id).toBe('one-expanded')
    expect(readMetadata).toHaveBeenCalledTimes(2)
  })

  it('selects the newest files before parsing with a deterministic canonical-path tie break', async () => {
    const { root, project, service } = setup(2)
    const oldest = join(root, 'c-oldest.jsonl')
    const tiedA = join(root, 'a-newest.jsonl')
    const tiedB = join(root, 'b-newest.jsonl')
    writeSession(oldest, project, 'oldest')
    writeSession(tiedA, project, 'newest-a')
    writeSession(tiedB, project, 'newest-b')
    const oldTime = new Date('2024-01-01T00:00:00.000Z')
    const newTime = new Date('2025-01-01T00:00:00.000Z')
    utimesSync(oldest, oldTime, oldTime)
    utimesSync(tiedA, newTime, newTime)
    utimesSync(tiedB, newTime, newTime)

    const records = await service.list()
    expect(records.map((record) => record.id)).toEqual(['newest-a', 'newest-b'])
  })

  it('canonicalizes daemon session paths and never regresses the JSONL update time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-live-catalog-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'live.jsonl')
    writeSession(file, project, 'live', '2025-02-01T00:00:00.000Z')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ sessionFile: ${JSON.stringify(file)}, isStreaming: true, modified: '2024-01-01T00:00:00.000Z' }] }))
  process.exit(0)
}
process.exit(2)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    const record = (await service.list())[0]
    expect(record?.filePath).toBe(realpathSync(file))
    expect(record?.status).toBe('running')
    expect(record?.updatedAt).toBe('2025-02-01T00:00:00.000Z')
  })

  it('does not let an in-flight pre-append scan satisfy a post-invalidation refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-scan-race-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'race.jsonl')
    writeSession(file, project, 'old')
    const canonical = realpathSync(file)
    const releases: Array<(value: SessionMetadata) => void> = []
    const catalog = new SessionMetadataCatalog(
      () => root,
      null,
      20,
      async () => new Promise<SessionMetadata>((resolveMetadata) => releases.push(resolveMetadata)),
    )

    const stale = catalog.all()
    await waitUntil(() => releases.length === 1)
    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'new', message: { role: 'user', content: 'new' } })}\n`)
    catalog.invalidateLiveCatalog()
    const refreshed = catalog.all()
    await waitUntil(() => releases.length === 2)
    releases[1](metadata(canonical, project, 'new'))
    await expect(refreshed).resolves.toMatchObject([{ id: 'new' }])
    releases[0](metadata(canonical, project, 'old'))
    await expect(stale).resolves.toMatchObject([{ id: 'old' }])
    await expect(catalog.all()).resolves.toMatchObject([{ id: 'new' }])
    expect(releases).toHaveLength(2)
  })
})


describe('SessionService live changes', () => {
  it('emits refreshes during continuous JSONL writes instead of waiting for the stream to stop', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'streaming.jsonl')
    writeSession(file, project, 'streaming')
    const events: Array<{ filePath?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))
    let index = 0
    const writes = setInterval(() => {
      appendFileSync(file, `${JSON.stringify({ type: 'message', id: `stream-${index++}`, message: { role: 'user', content: 'stream' } })}
`)
    }, 25)

    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 350))
      expect(events.some((event) => event.filePath === realpathSync(file))).toBe(true)
    } finally {
      clearInterval(writes)
      unsubscribe()
    }
  })

  it('debounces canonical JSONL changes, rejects outside aliases, and stops after unsubscribe', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'watched.jsonl')
    writeSession(file, project, 'watched')
    const events: Array<{ filePath?: string }> = []
    const unsubscribeThrowing = service.onDidChange(() => { throw new Error('listener failure') })
    const unsubscribe = service.onDidChange((event) => events.push(event))

    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'append', message: { role: 'user', content: 'append' } })}\n`)
    await waitUntil(() => events.some((event) => event.filePath === realpathSync(file)), 4_000)
    expect(events.filter((event) => event.filePath === realpathSync(file))).toHaveLength(1)

    const outside = join(root, '..', 'outside.jsonl')
    writeSession(outside, project, 'outside')
    symlinkSync(outside, join(root, 'outside-alias.jsonl'))
    const watcherHarness = service as unknown as { queueSessionChange(filename: string): void }
    watcherHarness.queueSessionChange('outside-alias.jsonl')
    await waitUntil(() => events.some((event) => event.filePath === undefined), 4_000)
    expect(events.some((event) => event.filePath === realpathSync(outside))).toBe(false)

    unsubscribeThrowing()
    unsubscribe()
    const count = events.length
    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'after-unsubscribe', message: { role: 'user', content: 'ignored' } })}\n`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    expect(events).toHaveLength(count)
  })
})

describe('SessionService transcript bounds', () => {
  it('returns a bounded recent suffix of long conversations', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'long.jsonl')
    const lines = [JSON.stringify({ type: 'session', id: 'long', cwd: project })]
    let parentId: string | null = null
    for (let index = 0; index < 450; index += 1) {
      const id = `message-${index}`
      lines.push(JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: `recent-${index}` } }))
      parentId = id
    }
    writeFileSync(file, `${lines.join('\n')}\n`)

    const transcript = await service.read(file)
    expect(transcript).toHaveLength(400)
    expect(transcript[0]?.id).toBe('message-50')
    expect(transcript.at(-1)?.id).toBe('message-449')
    expect(transcript.at(-1)?.parts).toEqual([{ type: 'text', text: 'recent-449' }])
  })

  it('caps tool arguments, tool output, and image data before IPC return', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'large-parts.jsonl')
    const largeArgs = `args-start-${'a'.repeat(300_000)}-args-end`
    const largeImage = `image-start-${'i'.repeat(600_000)}-image-end`
    const largeOutput = `output-start-${'o'.repeat(300_000)}-output-end`
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'large-parts', cwd: project }),
      JSON.stringify({
        type: 'message', id: 'assistant', parentId: null,
        message: { role: 'assistant', content: [
          { type: 'toolCall', id: 'tool', name: 'large-tool', arguments: largeArgs },
          { type: 'image', mimeType: 'image/png', data: largeImage },
        ] },
      }),
      JSON.stringify({
        type: 'message', id: 'tool-result', parentId: 'assistant',
        message: { role: 'toolResult', toolCallId: 'tool', toolName: 'large-tool', content: largeOutput },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    const parts = transcript[0]?.parts ?? []
    const call = parts.find((part) => part.type === 'toolCall')
    const result = parts.find((part) => part.type === 'toolResult')
    const image = parts.find((part) => part.type === 'image')
    expect(typeof call?.args).toBe('string')
    expect((call?.args as string).length).toBeLessThanOrEqual(128 * 1024)
    expect(result?.text.length).toBeLessThanOrEqual(128 * 1024)
    expect(image?.data?.length).toBeLessThanOrEqual(256 * 1024)
    expect(call?.args).toContain('[truncated]')
    expect(result?.text).toContain('[truncated]')
    expect(image?.data).toContain('[truncated]')
  })


  it('preserves agent messages as a distinct transcript role with only the readable body', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'agent-message.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'agent-message', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Delegate this task' } }),
      JSON.stringify({
        type: 'custom_message', id: 'handoff', parentId: 'root', customType: 'agent_message', display: true,
        content: '[from child:reviewer]\nAgent-to-agent message received.\n\nThe full envelope should not be shown.',
        details: {
          message: 'Review complete. The project authorization gate was the root cause.',
          from: { sessionName: 'project-reviewer', runtimeKind: 'subagent' },
        },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.at(-1)).toMatchObject({
      id: 'handoff',
      role: 'agent',
      agentName: 'project-reviewer',
      parts: [{ type: 'text', text: 'Review complete. The project authorization gate was the root cause.' }],
    })
  })

  it('preserves goal summaries as a distinct readable transcript role', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'goal-summary.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'goal-summary', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Start a goal' } }),
      JSON.stringify({
        type: 'custom_message', id: 'goal', parentId: 'root', customType: 'goal_context', display: true,
        content: '<goal_context>Internal control envelope that should stay hidden.</goal_context>',
        details: {
          kind: 'created',
          goalId: 'goal-1',
          objective: 'Ship the transcript activity refinements.',
          status: 'active',
          continuationsUsed: 0,
        },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.at(-1)).toMatchObject({
      id: 'goal',
      role: 'goal',
      parts: [{ type: 'text', text: 'Ship the transcript activity refinements.' }],
    })
    expect(JSON.stringify(transcript)).not.toContain('<goal_context>')
  })

  it('reconstructs only the final parent branch and merges assistant tool activity', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'branch.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'branch', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'keep-root' } }),
      JSON.stringify({ type: 'message', id: 'discarded', parentId: 'root', message: { role: 'user', content: 'discard-me' } }),
      JSON.stringify({
        type: 'message', id: 'assistant', parentId: 'root',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'lookup', arguments: { query: 'value' } }] },
      }),
      JSON.stringify({
        type: 'message', id: 'result', parentId: 'assistant',
        message: { role: 'toolResult', toolCallId: 'call', toolName: 'lookup', content: 'tool-output' },
      }),
      JSON.stringify({
        type: 'message', id: 'continuation', parentId: 'result',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final-answer' }] },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.map((message) => message.id)).toEqual(['root', 'assistant'])
    expect(transcript[1]?.parts.map((part) => part.type)).toEqual(['toolCall', 'toolResult', 'text'])
    expect(transcript[1]?.parts.at(-1)).toEqual({ type: 'text', text: 'final-answer' })
  })
})


describe('SessionService orchestration', () => {
  it('queues a follow-up through the Prime Agent daemon protocol', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-active-session-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'active.jsonl')
    writeSession(file, project, 'active')
    const socketPath = join(dir, 'daemon.sock')
    const commands: Array<Record<string, unknown>> = []
    const server = createServer((socket) => {
      socket.write(`${JSON.stringify({
        type: 'daemon_hello',
        protocol: { name: 'prime-agent.daemon', version: 7 },
        serverCapabilities: ['session_input_admission'],
      })}\n`)
      let buffered = ''
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const envelope = JSON.parse(line) as Record<string, unknown>
          const command = envelope.command as Record<string, unknown>
          commands.push(command)
          if (command.type === 'follow_up') {
            socket.write(`${JSON.stringify({ id: envelope.id, type: 'response', command: 'follow_up', success: true, data: { queued: true } })}\n`)
          }
        }
      })
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socketPath, resolveListen)
    })
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ id: 'active-worker', activeSessionId: 'active-worker', lifecycle: 'live', isSessionActive: true, sessionFile: ${JSON.stringify(file)} }] }))
  process.exit(0)
}
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify([{ status: 'current', isDefault: true, socketPath: ${JSON.stringify(socketPath)} }]))
  process.exit(0)
}
process.exit(2)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    try {
      await expect(service.followUp(file, 'queue this reply')).resolves.toBe(true)
      await waitUntil(() => commands.some((command) => command.type === 'ack_result'))
      expect(commands[0]).toMatchObject({
        type: 'follow_up', activeSessionId: 'active-worker', message: 'queue this reply',
      })
      expect(commands[1]).toMatchObject({ type: 'ack_result' })
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })

  it('rejects a daemon endpoint that is not a same-user Unix socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-untrusted-daemon-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'active.jsonl')
    writeSession(file, project, 'active')
    const socketPath = join(dir, 'not-a-socket')
    writeFileSync(socketPath, 'not a daemon')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ id: 'active-worker', lifecycle: 'live', isSessionActive: true, sessionFile: ${JSON.stringify(file)} }] }))
  process.exit(0)
}
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify([{ status: 'current', isDefault: true, socketPath: ${JSON.stringify(socketPath)} }]))
  process.exit(0)
}
process.exit(2)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    await expect(service.followUp(file, 'do not disclose this')).rejects.toThrow('untrusted daemon socket')
  })

  it('does not send a follow-up when the session is no longer active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-inactive-session-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'inactive.jsonl')
    writeSession(file, project, 'inactive')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ id: 'inactive-worker', activeSessionId: 'inactive-worker', lifecycle: 'live', isSessionActive: false, sessionFile: ${JSON.stringify(file)} }] }))
  process.exit(0)
}
process.exit(9)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    await expect(service.followUp(file, 'start normally instead')).resolves.toBe(false)
  })

  it('overlays runtime state and preserves archive and rename hook semantics', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'runtime.jsonl')
    writeSession(file, project, 'runtime')
    const safePath = await service.requireSessionPath(file)
    const stop = vi.fn(async () => undefined)
    const rename = vi.fn(async () => true)
    service.bindRuntimeHooks({
      get: (candidate) => candidate === safePath ? { isStreaming: true } : undefined,
      stop,
      rename,
    })

    expect((await service.list())[0]?.status).toBe('running')
    await expect(service.rename(file, '  Renamed session  ')).resolves.toBe(true)
    expect(rename).toHaveBeenCalledWith(safePath, 'Renamed session')
    await expect(service.rename(file, '-invalid')).rejects.toThrow('title contains invalid characters')

    await expect(service.archive(file)).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await service.list()).toEqual([])
    expect((await service.list(undefined, true))[0]?.archived).toBe(true)

    await expect(service.archive(file, false)).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect((await service.list())[0]?.archived).toBe(false)
  })
})
