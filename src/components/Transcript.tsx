import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCode2,
  Github,
  Globe2,
  LoaderCircle,
  MessageCircleQuestion,
  Target,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import React, { Fragment, memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitStatus, MessagePart, TranscriptMessage } from '@/types/api'
import { MarkdownText } from './MarkdownText'
import { boundText, newestWindow } from '@/lib/render-bounds'
import { PrimeMark } from './ui'

function InlineText({ text }: { text: string }) {
  const lines = text.split('\n')
  return <>{lines.map((line, lineIndex) => <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>{line.split(/(`[^`]+`)/g).map((fragment, index) => fragment.startsWith('`') && fragment.endsWith('`') ? <code key={index}>{fragment.slice(1, -1)}</code> : <Fragment key={index}>{fragment}</Fragment>)}{lineIndex < lines.length - 1 ? <br /> : null}</Fragment>)}</>
}

function timestamp(value?: string | number): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Format elapsed work without displaying empty higher-order units. */
export function formatWorkedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) return `${seconds}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours === 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

export type ToolKind = 'question' | 'terminal' | 'web' | 'git' | 'file' | 'mcp'

export function classifyTool(name: string): ToolKind {
  if (/ask[_\s.-]?user|ask\s+(?:a\s+)?question|ui\.select|request[_\s.-]?input/i.test(name)) return 'question'
  if (/bash|shell|terminal|command|exec|process/i.test(name)) return 'terminal'
  if (/github|\bgit\b|commit|branch|pull[_\s-]?request/i.test(name)) return 'git'
  if (/browser|web[_\s.-]?search|search[_\s.-]?web|fetch|https?|url|globe/i.test(name)) return 'web'
  if (/read|write|edit|file|path|directory|patch/i.test(name)) return 'file'
  return 'mcp'
}

function toolIcon(kind: ToolKind): ReactNode {
  if (kind === 'question') return <MessageCircleQuestion size={14} />
  if (kind === 'terminal') return <TerminalSquare size={14} />
  if (kind === 'web') return <Globe2 size={14} />
  if (kind === 'git') return <Github size={14} />
  if (kind === 'file') return <FileCode2 size={14} />
  return <Wrench size={14} />
}

function serialize(value: unknown, pretty = false): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, pretty ? 2 : undefined) } catch { return String(value) }
}

function toolPreview(part: Extract<MessagePart, { type: 'toolCall' }>): string {
  const raw = part.args
  if (raw && typeof raw === 'object') {
    const args = raw as Record<string, unknown>
    const preferred = args.question ?? args.command ?? args.query ?? args.url ?? args.path ?? args.cwd
    if (typeof preferred === 'string') return boundText(preferred.replace(/\s+/g, ' ').trim(), 180, '…')
  }
  return boundText(serialize(raw).replace(/\s+/g, ' ').trim(), 180, '…')
}

function SyntaxText({ text }: { text: string }) {
  const tokens = text.split(/("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b)/g)
  return <>{tokens.map((token, index) => {
    const className = /^".*"$/.test(token) ? (/(?=\s*:)/.test(text.slice(text.indexOf(token) + token.length)) ? 'syntax-key' : 'syntax-string')
      : /^(true|false|null)$/.test(token) ? 'syntax-keyword'
      : /^-?\d/.test(token) ? 'syntax-number' : undefined
    return <span className={className} key={`${index}-${token.slice(0, 8)}`}>{token}</span>
  })}</>
}

function ReasoningPart({ part }: { part: Extract<MessagePart, { type: 'thinking' }> }) {
  return (
    <div className="activity-line activity-line--reasoning">
      <MarkdownText text={boundText(part.text, 40_000, '\n… [Reasoning truncated in the desktop view.]')} />
    </div>
  )
}

function ThinkingDots({ labelled = false }: { labelled?: boolean }) {
  return (
    <span className="thinking-dots" role={labelled ? 'status' : undefined} aria-label={labelled ? 'Prime is thinking' : undefined} aria-hidden={labelled ? undefined : true}>
      <span /><span /><span />
    </span>
  )
}

function ToolPart({ part, next, active }: { part: Extract<MessagePart, { type: 'toolCall' }>; next?: MessagePart; active: boolean }) {
  const [open, setOpen] = useState(false)
  const result = next?.type === 'toolResult' ? next : undefined
  const failed = result?.isError
  const kind = classifyTool(part.name)
  const args = serialize(part.args, true)
  const output = result?.text ?? ''
  const visibleOutput = boundText(`${args}${args && output ? '\n\n' : ''}${output}`, 200_000, '\n\n[Output truncated in the desktop view.]')
  const canExpand = Boolean(visibleOutput)
  const expanded = canExpand && (active || open)
  const state = failed ? 'error' : result ? 'done' : kind === 'question' ? 'waiting' : 'running'
  return (
    <div className={`activity-line activity-line--tool activity-line--${kind} is-${state}`}>
      <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => { if (!active) setOpen((value) => !value) }} aria-expanded={canExpand ? expanded : undefined}>
        <span className="activity-line__icon">{toolIcon(kind)}</span>
        <span className="activity-line__kind">{kind === 'question' ? 'Question' : part.name}</span>
        {toolPreview(part) ? <code className="activity-tool__preview"><SyntaxText text={toolPreview(part)} /></code> : null}
        <span className="activity-tool__state">{failed ? <><CircleAlert size={12} /> failed</> : result ? <><Check size={12} /> done</> : kind === 'question' ? 'needs input' : <><LoaderCircle className="spin" size={12} /> running</>}</span>
        {canExpand ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      {expanded && visibleOutput ? <pre className="activity-tool__details"><SyntaxText text={visibleOutput} /></pre> : null}
    </div>
  )
}

function StandaloneToolResult({ part }: { part: Extract<MessagePart, { type: 'toolResult' }> }) {
  return <div className={`activity-line activity-line--result ${part.isError ? 'is-error' : ''}`}><span className="activity-line__icon">{part.isError ? <CircleAlert size={13} /> : <Check size={13} />}</span><span>{boundText(part.text, 2_000, '…')}</span></div>
}

function WorkTimeline({ parts, showReasoning, showTools, active }: { parts: MessagePart[]; showReasoning: boolean; showTools: boolean; active: boolean }) {
  const pairedResults = new Set<number>()
  return <div className="work-timeline">{parts.map((part, index) => {
    if (part.type === 'toolResult' && pairedResults.has(index)) return null
    if (part.type === 'thinking') return showReasoning ? <ReasoningPart key={index} part={part} /> : null
    if (part.type === 'toolCall') {
      if (!showTools) return null
      const next = parts[index + 1]
      if (next?.type === 'toolResult') pairedResults.add(index + 1)
      return <ToolPart key={part.id ?? index} part={part} next={next} active={active} />
    }
    if (part.type === 'toolResult') return showTools ? <StandaloneToolResult key={index} part={part} /> : null
    if (part.type === 'text') return <div className="activity-line activity-line--note" key={index}><MarkdownText text={part.text} /></div>
    return null
  })}</div>
}

function WorkDisclosure({ message, parts, showReasoning, showTools, active }: { message: TranscriptMessage; parts: MessagePart[]; showReasoning: boolean; showTools: boolean; active: boolean }) {
  const [open, setOpen] = useState(false)

  if (message.streaming || active) {
    return (
      <section className="work-disclosure is-running" aria-label="Prime work activity">
        <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} active />
        <div className="work-disclosure__thinking"><ThinkingDots labelled /></div>
      </section>
    )
  }

  const startedAt = timestamp(message.startedAt ?? message.timestamp) ?? 0
  const completedAt = timestamp(message.completedAt) ?? startedAt
  const duration = formatWorkedDuration(Math.max(0, completedAt - startedAt))
  return (
    <section className="work-disclosure">
      <button type="button" className="work-disclosure__button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>Worked for {duration}</span>
      </button>
      {open ? <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} active={false} /> : null}
    </section>
  )
}

function ChangesCard({ git, onOpenChanges }: { git: GitStatus; onOpenChanges(): void }) {
  const additions = git.files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = git.files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <button type="button" className="changes-card" onClick={onOpenChanges}>
      <span className="changes-card__icon"><FileCode2 size={16} /></span>
      <span className="changes-card__text"><strong>{git.files.length} {git.files.length === 1 ? 'file' : 'files'} changed</strong><small>Review changes in the inspector</small></span>
      <span className="diff-count diff-count--add">+{additions}</span><span className="diff-count diff-count--remove">−{deletions}</span><ChevronRight size={14} />
    </button>
  )
}

function renderNarrative(parts: MessagePart[], keyPrefix: string) {
  return parts.map((part, index) => {
    if (part.type === 'text') return <MarkdownText key={`${keyPrefix}-${index}`} text={part.text} />
    if (part.type === 'image') return <div key={`${keyPrefix}-${index}`} className="image-part">Image attachment</div>
    return null
  })
}

function messageText(message: TranscriptMessage): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall back to the document copy command when clipboard permission is unavailable.
    }
  }
  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Copy is unavailable')
}

function MessageActions({ message, text: suppliedText }: { message: TranscriptMessage; text?: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const text = suppliedText ?? messageText(message)
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'agent' ? 'agent' : 'user'

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
  }, [])

  if (!text) return null

  const copyMessage = async () => {
    try {
      await writeClipboardText(text)
      setCopied(true)
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="message-actions">
      <button type="button" disabled={!text} aria-label={`${copied ? 'Copied' : 'Copy'} ${role} message`} onClick={() => void copyMessage()}>
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({ message, active, showReasoning, showTools }: { message: TranscriptMessage; active: boolean; showReasoning: boolean; showTools: boolean }) {
  const firstActivity = message.parts.findIndex((part) => part.type === 'thinking' || part.type === 'toolCall' || part.type === 'toolResult')
  let lastActivity = -1
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    if (message.parts[index].type === 'thinking' || message.parts[index].type === 'toolCall' || message.parts[index].type === 'toolResult') { lastActivity = index; break }
  }
  const hasVisibleActivity = firstActivity >= 0 && (showReasoning && message.parts.some((part) => part.type === 'thinking') || showTools && message.parts.some((part) => part.type === 'toolCall' || part.type === 'toolResult'))
  const before = firstActivity < 0 ? message.parts : message.parts.slice(0, firstActivity)
  const work = firstActivity < 0 ? [] : message.parts.slice(firstActivity, lastActivity + 1)
  const after = firstActivity < 0 ? [] : message.parts.slice(lastActivity + 1)
  const hiddenMiddleNarrative = !hasVisibleActivity ? work.filter((part) => part.type === 'text' || part.type === 'image') : []
  const copyableNarrative = hasVisibleActivity ? [...before, ...after] : [...before, ...hiddenMiddleNarrative, ...after]
  const copyableText = copyableNarrative.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
  return (
    <article className="message message--assistant">
      <div className="assistant-mark"><PrimeMark size={24} /></div>
      <div className="message__content">
        {renderNarrative(before, 'before')}
        {hasVisibleActivity ? <WorkDisclosure message={message} parts={work} showReasoning={showReasoning} showTools={showTools} active={active} /> : renderNarrative(hiddenMiddleNarrative, 'middle')}
        {renderNarrative(after, 'after')}
        {(message.streaming || active) && !hasVisibleActivity ? <div className="streaming-state" aria-live="polite"><ThinkingDots /> Prime is working</div> : null}
        {!message.streaming && !active ? <MessageActions message={message} text={copyableText} /> : null}
      </div>
    </article>
  )
}, (previous, next) => previous.message === next.message && previous.active === next.active && previous.showReasoning === next.showReasoning && previous.showTools === next.showTools)

const UserMessage = memo(function UserMessage({ message }: { message: TranscriptMessage }) {
  return <article className="message message--user"><div className="user-bubble">{message.parts.map((part, partIndex) => part.type === 'text' ? <InlineText key={partIndex} text={part.text} /> : null)}</div><MessageActions message={message} /></article>
})

const AgentMessage = memo(function AgentMessage({ message }: { message: TranscriptMessage }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  const label = message.agentName ? `Message from agent: ${message.agentName}` : 'Message from agent'
  return (
    <article className={`message message--agent ${open ? 'is-open' : ''}`}>
      <button type="button" className="agent-message__summary" aria-expanded={open} aria-controls={contentId} aria-label={label} onClick={() => setOpen((value) => !value)}>
        <PrimeMark size={18} />
        <span className="agent-message__label">Message from agent</span>
        {message.agentName ? <span className="agent-message__name">{message.agentName}</span> : null}
        {open ? <ChevronDown className="agent-message__chevron" size={13} /> : <ChevronRight className="agent-message__chevron" size={13} />}
      </button>
      {open ? <div className="agent-message__content" id={contentId}><MarkdownText text={boundText(text, 40_000, '\n… [Agent message truncated in the desktop view.]')} /><MessageActions message={message} /></div> : null}
    </article>
  )
})

const GoalMessage = memo(function GoalMessage({ message }: { message: TranscriptMessage }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const text = messageText(message)
  return (
    <article className={`message message--goal ${open ? 'is-open' : ''}`}>
      <button type="button" className="goal-message__summary" aria-expanded={open} aria-controls={contentId} aria-label="Goal summary" onClick={() => setOpen((value) => !value)}>
        <span className="goal-message__icon"><Target size={15} /></span>
        <span className="goal-message__label">Goal summary</span>
        {open ? <ChevronDown className="goal-message__chevron" size={13} /> : <ChevronRight className="goal-message__chevron" size={13} />}
      </button>
      {open ? <div className="goal-message__content" id={contentId}><MarkdownText text={boundText(text, 40_000, '\n… [Goal summary truncated in the desktop view.]')} /></div> : null}
    </article>
  )
})

interface TranscriptProps {
  messages: TranscriptMessage[]
  git: GitStatus
  loading?: boolean
  active?: boolean
  showReasoning?: boolean
  showTools?: boolean
  onOpenChanges(): void
  onSuggestion(prompt: string): void
  suggestionsDisabled?: boolean
}

export function Transcript({ messages, git, loading, active = false, showReasoning = true, showTools = true, onOpenChanges, onSuggestion, suggestionsDisabled }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousCountRef = useRef(0)
  const previousStreamingRef = useRef(false)
  const pinnedToBottomRef = useRef(true)
  const [visibleLimit, setVisibleLimit] = useState(250)
  const [announcement, setAnnouncement] = useState('')
  const streaming = active || messages.some((message) => message.streaming)
  const visibleMessages = useMemo(() => newestWindow(messages, visibleLimit), [messages, visibleLimit])
  const hiddenCount = messages.length - visibleMessages.length
  const activeAssistantId = active && messages.at(-1)?.role === 'assistant' ? messages.at(-1)?.id : undefined

  useEffect(() => {
    const firstLoadedTranscript = previousCountRef.current === 0 && messages.length > 0
    const scroller = scrollRef.current
    if (firstLoadedTranscript) {
      requestAnimationFrame(() => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' }))
      pinnedToBottomRef.current = true
    } else if (streaming && pinnedToBottomRef.current) {
      requestAnimationFrame(() => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' }))
    }
    if (previousStreamingRef.current && !streaming) setAnnouncement('Prime response complete.')
    else if (!previousStreamingRef.current && streaming) setAnnouncement('Prime is working.')
    previousStreamingRef.current = streaming
    previousCountRef.current = messages.length
  }, [messages, streaming])

  const updatePinnedState = () => {
    const scroller = scrollRef.current
    if (scroller) pinnedToBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
  }

  return (
    <>
    <div ref={scrollRef} className={`transcript scroll-area ${git.files.length ? 'has-pinned-changes' : ''}`} aria-busy={loading} onScroll={updatePinnedState}>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <div className="transcript__inner">
        {loading ? <div className="transcript-loading"><LoaderCircle className="spin" size={16} /> Loading session…</div> : null}
        {!loading && messages.length === 0 ? (
          <div className="session-welcome">
            <PrimeMark size={34} />
            <h1>What should we work on?</h1>
            <p>Prime can inspect this project, edit files, run tools, and keep working across sessions.</p>
            <div className="prompt-suggestions"><button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Summarize this project')}>Summarize this project</button><button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Find a useful next task')}>Find a useful next task</button><button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Run the test suite')}>Run the test suite</button></div>
          </div>
        ) : null}
        {hiddenCount > 0 ? <button type="button" className="transcript__show-earlier" onClick={() => setVisibleLimit((limit) => Math.min(messages.length, limit + 250))}>Show {Math.min(250, hiddenCount)} earlier messages</button> : null}
        {visibleMessages.map((message) => message.role === 'user' ? (
          <UserMessage key={message.id} message={message} />
        ) : message.role === 'assistant' ? (
          <AssistantMessage key={message.id} message={message} active={message.id === activeAssistantId} showReasoning={showReasoning} showTools={showTools} />
        ) : message.role === 'agent' ? (
          <AgentMessage key={message.id} message={message} />
        ) : message.role === 'goal' ? (
          <GoalMessage key={message.id} message={message} />
        ) : (
          <div className={`message message--${message.role}`} key={message.id}>{message.parts.map((part, partIndex) => part.type === 'text' ? <span key={partIndex}>{part.text}</span> : null)}</div>
        ))}
        {active && !activeAssistantId ? (
          <article className="message message--assistant transcript-active-placeholder" aria-live="polite">
            <div className="assistant-mark"><PrimeMark size={24} /></div>
            <div className="streaming-state"><ThinkingDots /> Prime is working</div>
          </article>
        ) : null}
        <div />
      </div>
    </div>
    {git.files.length ? <div className="transcript-changes-pin"><ChangesCard git={git} onOpenChanges={onOpenChanges} /></div> : null}
    </>
  )
}
