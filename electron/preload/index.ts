import { contextBridge, ipcRenderer } from 'electron'
import type { PrimeEventEnvelope, PrimeWorkApi, SessionChangeEvent, TerminalDataEvent, TerminalExitEvent } from '../../src/types/api'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    if (typeof payload === 'object' && payload !== null) callback(payload as T)
  }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: PrimeWorkApi = {
  app: {
    getMeta: () => ipcRenderer.invoke('app:get-meta'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    revealPath: (path) => ipcRenderer.invoke('app:reveal-path', path),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    listFiles: (root) => ipcRenderer.invoke('projects:list-files', root),
    add: () => ipcRenderer.invoke('projects:add'),
    grantInferred: (path) => ipcRenderer.invoke('projects:grant-inferred', path),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    touch: (id) => ipcRenderer.invoke('projects:touch', id),
  },
  sessions: {
    list: (projectPath, includeArchived) => ipcRenderer.invoke('sessions:list', projectPath, includeArchived),
    read: (filePath) => ipcRenderer.invoke('sessions:read', filePath),
    followUp: (filePath, message) => ipcRenderer.invoke('sessions:follow-up', filePath, message),
    rename: (filePath, title) => ipcRenderer.invoke('sessions:rename', filePath, title),
    archive: (filePath, archived) => ipcRenderer.invoke('sessions:archive', filePath, archived),
    onChanged: (callback) => subscribe<SessionChangeEvent>('sessions:changed', callback),
  },
  agent: {
    start: (options) => ipcRenderer.invoke('agent:start', options),
    command: (runtimeId, command) => ipcRenderer.invoke('agent:command', runtimeId, command),
    stop: (runtimeId) => ipcRenderer.invoke('agent:stop', runtimeId),
    list: () => ipcRenderer.invoke('agent:list'),
    onEvent: (callback) => subscribe<PrimeEventEnvelope>('agent:event', callback),
  },
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    input: (terminalId, data) => { ipcRenderer.send('terminal:input', terminalId, data) },
    resize: (terminalId, cols, rows) => { ipcRenderer.send('terminal:resize', terminalId, cols, rows) },
    kill: (terminalId) => ipcRenderer.invoke('terminal:kill', terminalId),
    onData: (callback) => subscribe<TerminalDataEvent>('terminal:data', callback),
    onExit: (callback) => subscribe<TerminalExitEvent>('terminal:exit', callback),
  },
  git: {
    status: (cwd) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd, path, staged) => ipcRenderer.invoke('git:diff', cwd, path, staged),
    stage: (cwd, paths) => ipcRenderer.invoke('git:stage', cwd, paths),
    unstage: (cwd, paths) => ipcRenderer.invoke('git:unstage', cwd, paths),
    restore: (cwd, paths) => ipcRenderer.invoke('git:restore', cwd, paths),
    commit: (cwd, message) => ipcRenderer.invoke('git:commit', cwd, message),
  },
  plugins: {
    list: (projectPath) => ipcRenderer.invoke('plugins:list', projectPath),
    install: (source) => ipcRenderer.invoke('plugins:install', source),
    connectMcp: (input) => ipcRenderer.invoke('plugins:connect-mcp', input),
    refresh: () => ipcRenderer.invoke('plugins:refresh'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    resetBrowserData: () => ipcRenderer.invoke('settings:reset-browser-data'),
  },
  schedules: {
    list: (runtimeId) => ipcRenderer.invoke('schedules:list', runtimeId),
    add: (runtimeId, schedule, prompt) => ipcRenderer.invoke('schedules:add', runtimeId, schedule, prompt),
    cancel: (runtimeId, jobId) => ipcRenderer.invoke('schedules:cancel', runtimeId, jobId),
  },
}

for (const domain of Object.values(api)) Object.freeze(domain)
contextBridge.exposeInMainWorld('prime', Object.freeze(api))
