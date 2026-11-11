import type { WebgalRuntimeHost } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'

/**
 * 固定 `webgal-engine@4.6.5` 的编辑器同步协议没有这些确认。
 * 不能用 sync-scene、run-scene-content 或 iframe load 补上。
 */
export const MISSING_PREVIEW_CONTROL_COMMANDS = [
  'preview.command.pause',
  'preview.command.resume',
  'preview.command.apply-draft-dialogue',
  'preview.command.capture-position',
  'preview.command.restore-position'
] as const

export const MISSING_PREVIEW_CONTROL_EVENTS = [
  'preview.control.paused',
  'preview.control.resumed',
  'preview.control.replayed',
  'preview.control.draft-applied',
  'preview.control.captured',
  'preview.control.restored'
] as const

const installedCommands: ReadonlySet<string> = new Set(WEBGAL_COMPATIBILITY_PROFILE.previewCommands)
const controlEventTypes: ReadonlySet<string> = new Set(MISSING_PREVIEW_CONTROL_EVENTS)

export type PreviewControlEventType = (typeof MISSING_PREVIEW_CONTROL_EVENTS)[number]

export type PreviewControlConfirmation = {
  readonly type: PreviewControlEventType
  readonly generation: number
  readonly sentenceId: number
  readonly phase: 'paused' | 'playing' | 'completed'
  readonly position?:
    | { readonly kind: 'dialogue'; readonly dialogueId: string }
    | { readonly kind: 'nonDialogue' }
    | { readonly kind: 'completed' }
    | { readonly kind: 'unknown' }
  readonly dialogueId?: string
}

export type PreviewControlCapability =
  | { readonly status: 'available' }
  | {
      readonly status: 'unavailable'
      readonly missingCommands: readonly string[]
      readonly missingEvents: readonly string[]
    }

/**
 * 预览专用控制桥。
 * 固定引擎没有暂停、继续、草稿、捕获或恢复的命令和确认事件时，明确报告能力不可用。
 */
export class WebgalPreviewControlBridge {
  private readonly waiters = new Set<(confirmation: PreviewControlConfirmation) => void>()
  private removeHostConnection: (() => void) | undefined

  constructor(private readonly host: WebgalRuntimeHost) {}

  controlCapability(): PreviewControlCapability {
    const missingCommands = MISSING_PREVIEW_CONTROL_COMMANDS.filter(
      (command) => !installedCommands.has(command)
    )
    if (missingCommands.length === 0) return { status: 'available' }
    return {
      status: 'unavailable',
      missingCommands,
      missingEvents: MISSING_PREVIEW_CONTROL_EVENTS
    }
  }

  /**
   * 只转发引擎发出的固定控制确认。
   * 连接出现、iframe load 和旧协议快照都不进入这里。
   */
  subscribe(listener: (confirmation: PreviewControlConfirmation) => void): () => void {
    this.ensureAttached()
    this.waiters.add(listener)
    return () => this.waiters.delete(listener)
  }

  dispose(): void {
    this.removeHostConnection?.()
    this.removeHostConnection = undefined
    this.waiters.clear()
  }

  private ensureAttached(): void {
    if (this.removeHostConnection) return
    this.removeHostConnection = this.host.onPreviewConnection((connection) => {
      connection.onMessage((message) => this.receive(message))
    })
  }

  private receive(message: unknown): void {
    if (!isControlConfirmation(message)) return
    for (const waiter of this.waiters) waiter(message)
  }
}

function isControlConfirmation(value: unknown): value is PreviewControlConfirmation {
  if (!value || typeof value !== 'object') return false
  if (
    !('type' in value) ||
    !('generation' in value) ||
    !('sentenceId' in value) ||
    !('phase' in value)
  ) {
    return false
  }
  const message = value as {
    type: unknown
    generation: unknown
    sentenceId: unknown
    phase: unknown
    position?: unknown
    dialogueId?: unknown
  }
  if (!controlEventTypes.has(String(message.type))) return false
  if (typeof message.generation !== 'number' || typeof message.sentenceId !== 'number') return false
  if (message.phase !== 'paused' && message.phase !== 'playing' && message.phase !== 'completed') {
    return false
  }
  if (message.dialogueId !== undefined && typeof message.dialogueId !== 'string') return false
  return message.position === undefined || isPosition(message.position)
}

function isPosition(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false
  const position = value as { kind: unknown; dialogueId?: unknown }
  if (position.kind === 'dialogue') return typeof position.dialogueId === 'string'
  return (
    position.kind === 'nonDialogue' || position.kind === 'completed' || position.kind === 'unknown'
  )
}
