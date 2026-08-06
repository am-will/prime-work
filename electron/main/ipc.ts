import { app, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { AppMeta } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { GitService } from './git'
import type { PluginService } from './plugins'
import type { ProjectService } from './projects'
import type { ScheduleService, SettingsService } from './settings-schedules'
import type { SessionService } from './sessions'
import type { TerminalService } from './terminal'
import { requireExistingPath, requireWebUrl } from './validation'

interface Services {
  meta: AppMeta
  projects: ProjectService
  sessions: SessionService
  agents: AgentRpcManager
  terminals: TerminalService
  git: GitService
  plugins: PluginService
  settings: SettingsService
  schedules: ScheduleService
}

type IpcEvent = IpcMainInvokeEvent | IpcMainEvent

export function isTrustedRendererUrl(url: string, expectedRendererUrl: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(expectedRendererUrl)
    // Fragments never cross the document/security boundary; allow in-document anchors only.
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}

export interface IpcRegistration {
  authorize(webContents: WebContents): void
  revoke(webContentsId: number): void
  dispose(): void
}

export function registerIpc(services: Services, expectedRendererUrl: string): IpcRegistration {
  const authorized = new Map<number, WebContents>()
  const invokeChannels: string[] = []
  const eventChannels: string[] = []
  let closed = false

  const verify = (event: IpcEvent): void => {
    const trustedFrame = event.senderFrame === event.sender.mainFrame
      && isTrustedRendererUrl(event.senderFrame.url, expectedRendererUrl)
      && isTrustedRendererUrl(event.sender.getURL(), expectedRendererUrl)
    if (closed || !authorized.has(event.sender.id) || event.sender.isDestroyed() || !trustedFrame) throw new Error('IPC sender is not authorized')
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => { verify(event); return listener(event, ...args) })
    invokeChannels.push(channel)
  }
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]) => {
      try { verify(event); listener(event, ...args) } catch (error) { console.warn(`Rejected ${channel}:`, error instanceof Error ? error.message : error) }
    }
    ipcMain.on(channel, wrapped)
    eventChannels.push(channel)
  }

  handle('app:get-meta', () => services.meta)
  handle('app:open-external', async (_event, url) => {
    try { await shell.openExternal(requireWebUrl(url, { mailto: true }), { activate: true }); return true } catch { return false }
  })
  handle('app:reveal-path', async (_event, path) => {
    try {
      const requested = await requireExistingPath(path)
      let authorized: string
      try { authorized = await services.projects.authorizePath(requested) }
      catch {
        try { authorized = await services.sessions.requireSessionPath(requested) }
        catch { authorized = services.plugins.authorizeReveal(requested) }
      }
      shell.showItemInFolder(authorized)
      return true
    } catch { return false }
  })

  handle('projects:list', () => services.projects.list())
  handle('projects:list-files', (_event, root) => services.projects.listFiles(root))
  handle('projects:add', () => services.projects.add())
  handle('projects:grant-inferred', (_event, path) => services.projects.grantInferred(path))
  handle('projects:remove', (_event, id) => services.projects.remove(id))
  handle('projects:touch', (_event, id) => services.projects.touch(id))

  handle('sessions:list', (_event, projectPath, includeArchived) => services.sessions.list(projectPath as string | undefined, includeArchived))
  handle('sessions:read', (_event, filePath) => services.sessions.read(filePath as string))
  handle('sessions:follow-up', (_event, filePath, message) => services.sessions.followUp(filePath as string, message as string))
  handle('sessions:rename', (_event, filePath, title) => services.sessions.rename(filePath as string, title as string))
  handle('sessions:archive', (_event, filePath, archived) => services.sessions.archive(filePath as string, archived))

  handle('agent:start', (_event, options) => services.agents.start(options))
  handle('agent:command', (_event, runtimeId, command) => services.agents.command(runtimeId, command))
  handle('agent:stop', (_event, runtimeId) => services.agents.stop(runtimeId))
  handle('agent:list', () => services.agents.list())

  handle('terminal:create', (event, options) => services.terminals.create(event.sender, options))
  on('terminal:input', (event, terminalId, data) => services.terminals.input(event.sender, terminalId, data))
  on('terminal:resize', (event, terminalId, cols, rows) => services.terminals.resize(event.sender, terminalId, cols, rows))
  handle('terminal:kill', (event, terminalId) => services.terminals.kill(event.sender, terminalId))

  handle('git:status', (_event, cwd) => services.git.status(cwd))
  handle('git:diff', (_event, cwd, path, staged) => services.git.diff(cwd, path, staged))
  handle('git:stage', (_event, cwd, paths) => services.git.stage(cwd, paths))
  handle('git:unstage', (_event, cwd, paths) => services.git.unstage(cwd, paths))
  handle('git:restore', (_event, cwd, paths) => services.git.restore(cwd, paths))
  handle('git:commit', (_event, cwd, message) => services.git.commit(cwd, message))

  handle('plugins:list', (_event, projectPath) => services.plugins.list(projectPath as string | undefined))
  handle('plugins:install', (_event, source) => services.plugins.install(source))
  handle('plugins:connect-mcp', (_event, input) => services.plugins.connectMcp(input))
  handle('plugins:refresh', () => services.plugins.refresh())

  handle('settings:get', () => services.settings.get())
  handle('settings:update', (_event, patch) => services.settings.update(patch))
  handle('settings:reset-browser-data', () => services.settings.resetBrowserData())

  handle('schedules:list', (_event, runtimeId) => services.schedules.list(runtimeId))
  handle('schedules:add', (_event, runtimeId, schedule, prompt) => services.schedules.add(runtimeId, schedule, prompt))
  handle('schedules:cancel', (_event, runtimeId, jobId) => services.schedules.cancel(runtimeId, jobId))

  const unsubscribeSessionChanges = services.sessions.onDidChange((change) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('sessions:changed', change)
    }
  })

  return {
    authorize(webContents) { if (!closed) authorized.set(webContents.id, webContents) },
    revoke(webContentsId) { authorized.delete(webContentsId); services.terminals.killOwner(webContentsId) },
    dispose() {
      if (closed) return
      closed = true
      authorized.clear()
      unsubscribeSessionChanges()
      for (const channel of invokeChannels) ipcMain.removeHandler(channel)
      // Event listeners are removed wholesale only for our private fixed channels.
      for (const channel of eventChannels) ipcMain.removeAllListeners(channel)
    },
  }
}
