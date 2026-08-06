export type ThemeMode = 'system' | 'light' | 'dark'
export type WorkspaceView = 'session' | 'projects' | 'activity' | 'scheduled' | 'plugins' | 'settings'
export type InspectorTab = 'summary' | 'changes' | 'browser' | 'files'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'complete' | 'failed' | 'unknown'

export interface AppMeta {
  version: string
  platform: NodeJS.Platform
  homeDir: string
  primeAgentPath: string | null
  primeAgentVersion: string | null
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
  folders: string[]
  primaryFolder: string
  pinned: boolean
  createdAt: string
  lastOpenedAt: string
  sessionCount: number
  gitBranch?: string
  inferred?: boolean
}

export interface SessionRecord {
  id: string
  filePath: string
  projectPath: string
  title: string
  createdAt: string
  updatedAt: string
  status: SessionStatus
  model?: string
  provider?: string
  thinkingLevel?: string
  depth: number
  pinned?: boolean
  unread?: boolean
  preview?: string
  archived?: boolean
  syncRevision?: number
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; id?: string; name: string; args?: unknown }
  | { type: 'toolResult'; name?: string; text: string; isError?: boolean }
  | { type: 'image'; mimeType?: string; data?: string }

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'agent' | 'goal' | 'tool' | 'system'
  timestamp?: string | number
  agentName?: string
  startedAt?: string | number
  completedAt?: string | number
  parts: MessagePart[]
  streaming?: boolean
}

export interface RuntimeInfo {
  runtimeId: string
  sessionId?: string
  sessionFile?: string
  cwd: string
  isStreaming: boolean
  model?: { provider?: string; id?: string; name?: string } | null
  thinkingLevel?: string
}

export interface PrimeEventEnvelope {
  runtimeId: string
  event: Record<string, unknown>
}

export interface SessionChangeEvent {
  filePath?: string
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  kind: 'skill' | 'extension' | 'prompt' | 'package' | 'mcp'
  location: 'bundled' | 'user' | 'project' | 'system'
  path?: string
  enabled: boolean
  icon?: string
  source?: string
}

export type McpConnectionInput = {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
} & (
  | { type: 'http'; url: string }
  | { type: 'stdio'; command: string; args?: string[] }
)

export interface ProjectFileEntry { path: string; type: 'file' | 'directory' }

export interface GitFileChange {
  path: string
  status: string
  staged: boolean
  additions: number
  deletions: number
}
export interface GitStatus {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileChange[]
  truncated?: boolean
  error?: string
}
export interface GitDiff { path?: string; staged: boolean; text: string; truncated: boolean; error?: string }

export interface TerminalSpawnOptions { cwd: string; shell?: string; cols?: number; rows?: number }
export interface TerminalDataEvent { terminalId: string; data: string }
export interface TerminalExitEvent { terminalId: string; exitCode: number; signal?: number }

export interface AppSettings {
  theme: ThemeMode
  sidebarOpen: boolean
  inspectorOpen: boolean
  terminalOpen: boolean
  defaultInspectorTab: InspectorTab
  browserHome: string
  browserAskForDownloads: boolean
  terminalShell: string
  reduceMotion: boolean
  showReasoningSummaries: boolean
  showToolCalls: boolean
  telemetry: boolean
}

export interface ScheduleRecord {
  id: string
  title: string
  schedule: string
  prompt: string
  status: 'active' | 'paused' | 'completed' | 'failed'
  nextRun?: string
  lastRun?: string
  runtimeId?: string
}

export interface PrimeWorkApi {
  app: { getMeta(): Promise<AppMeta>; openExternal(url: string): Promise<boolean>; revealPath(path: string): Promise<boolean> }
  projects: { list(): Promise<ProjectRecord[]>; listFiles(root: string): Promise<ProjectFileEntry[]>; add(): Promise<ProjectRecord | null>; grantInferred(path: string): Promise<ProjectRecord>; remove(id: string): Promise<boolean>; touch(id: string): Promise<boolean> }
  sessions: {
    list(projectPath?: string, includeArchived?: boolean): Promise<SessionRecord[]>
    read(filePath: string): Promise<TranscriptMessage[]>
    followUp(filePath: string, message: string): Promise<boolean>
    rename(filePath: string, title: string): Promise<boolean>
    archive(filePath: string, archived?: boolean): Promise<boolean>
    onChanged(callback: (event: SessionChangeEvent) => void): () => void
  }
  agent: {
    start(options: { cwd: string; sessionPath?: string; model?: string; thinking?: string }): Promise<RuntimeInfo>
    command(runtimeId: string, command: Record<string, unknown>): Promise<Record<string, unknown>>
    stop(runtimeId: string): Promise<boolean>
    list(): Promise<RuntimeInfo[]>
    onEvent(callback: (envelope: PrimeEventEnvelope) => void): () => void
  }
  terminal: {
    create(options: TerminalSpawnOptions): Promise<{ terminalId: string; shell: string }>
    input(terminalId: string, data: string): void
    resize(terminalId: string, cols: number, rows: number): void
    kill(terminalId: string): Promise<boolean>
    onData(callback: (event: TerminalDataEvent) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
  }
  git: { status(cwd: string): Promise<GitStatus>; diff(cwd: string, path?: string, staged?: boolean): Promise<GitDiff>; stage(cwd: string, paths: string[]): Promise<boolean>; unstage(cwd: string, paths: string[]): Promise<boolean>; restore(cwd: string, paths: string[]): Promise<boolean>; commit(cwd: string, message: string): Promise<{ ok: boolean; output: string }> }
  plugins: { list(projectPath?: string): Promise<SkillRecord[]>; install(source: string): Promise<{ ok: boolean; output: string }>; connectMcp(input: McpConnectionInput): Promise<{ ok: boolean; output: string }>; refresh(): Promise<SkillRecord[]> }
  settings: { get(): Promise<AppSettings>; update(patch: Partial<AppSettings>): Promise<AppSettings>; resetBrowserData(): Promise<boolean> }
  schedules: { list(runtimeId?: string): Promise<ScheduleRecord[]>; add(runtimeId: string, schedule: string, prompt: string): Promise<Record<string, unknown>>; cancel(runtimeId: string, jobId: string): Promise<Record<string, unknown>> }
}

declare global { interface Window { prime: PrimeWorkApi } }
