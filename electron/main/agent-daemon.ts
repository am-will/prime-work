import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { StrictJsonlDecoder } from './jsonl'
import { isRecord } from './validation'

const DAEMON_PROTOCOL_NAME = 'prime-agent.daemon'
const DAEMON_PROTOCOL_VERSION = 7
const MAX_DAEMON_FRAME_BYTES = 1024 * 1024

export async function queueDaemonFollowUp(socketPath: string, activeSessionId: string, message: string): Promise<void> {
  if (!isAbsolute(socketPath) || socketPath.includes('\0') || socketPath.length > 4_096) {
    throw new Error('Prime Agent returned an invalid daemon socket path')
  }
  let socketInfo
  try { socketInfo = await lstat(socketPath) } catch { throw new Error('Prime Agent daemon socket is unavailable') }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!socketInfo.isSocket() || (currentUid !== undefined && socketInfo.uid !== currentUid)) {
    throw new Error('Prime Agent returned an untrusted daemon socket')
  }

  await new Promise<void>((resolveQueue, rejectQueue) => {
    const socket = createConnection(socketPath)
    const commandId = `prime_work_${randomUUID()}`
    const clientId = `prime-work-${randomUUID()}`
    let commandSent = false
    let settled = false
    let protocolVersion = DAEMON_PROTOCOL_VERSION
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) rejectQueue(error)
      else resolveQueue()
    }
    const timer = setTimeout(() => finish(new Error('Prime Agent daemon follow-up timed out')), 10_000)
    timer.unref()
    const write = (value: Record<string, unknown>): void => {
      try { socket.write(`${JSON.stringify(value)}\n`) }
      catch { finish(new Error('Prime Work could not write to the Prime Agent daemon')) }
    }
    const decoder = new StrictJsonlDecoder((line) => {
      let value: unknown
      try { value = JSON.parse(line) } catch { finish(new Error('Prime Agent daemon returned malformed JSON')); return }
      if (!isRecord(value)) return
      if (value.type === 'daemon_hello' && !commandSent) {
        const protocol = isRecord(value.protocol) ? value.protocol : undefined
        if (protocol?.name !== DAEMON_PROTOCOL_NAME || typeof protocol.version !== 'number'
          || protocol.version < DAEMON_PROTOCOL_VERSION
          || !Array.isArray(value.serverCapabilities)
          || !value.serverCapabilities.includes('session_input_admission')) {
          finish(new Error('Prime Agent daemon does not support active-session follow-ups'))
          return
        }
        commandSent = true
        protocolVersion = Math.min(protocol.version, DAEMON_PROTOCOL_VERSION)
        const command = { id: commandId, type: 'follow_up', activeSessionId, message }
        write({
          type: 'command',
          id: commandId,
          protocol: { name: DAEMON_PROTOCOL_NAME, version: protocolVersion },
          clientId,
          command,
        })
        return
      }
      if (value.type !== 'response' || value.id !== commandId) return
      if (value.command !== 'follow_up' || value.success !== true) {
        finish(new Error('Prime Agent rejected the queued reply'))
        return
      }
      const ackId = `prime_work_ack_${randomUUID()}`
      const ack = {
        type: 'command',
        id: ackId,
        protocol: { name: DAEMON_PROTOCOL_NAME, version: protocolVersion },
        clientId,
        command: { id: ackId, type: 'ack_result', commandId },
      }
      try { socket.end(`${JSON.stringify(ack)}\n`, () => finish()) }
      catch { finish(new Error('Prime Work could not acknowledge the queued reply')) }
    }, MAX_DAEMON_FRAME_BYTES)

    socket.on('data', (chunk: Buffer) => {
      try { decoder.push(chunk) } catch { finish(new Error('Prime Agent daemon response exceeded its limit')) }
    })
    socket.once('error', () => finish(new Error('Prime Work could not connect to the Prime Agent daemon')))
    socket.once('close', () => { if (!settled) finish(new Error('Prime Agent daemon closed before queuing the reply')) })
  })
}
