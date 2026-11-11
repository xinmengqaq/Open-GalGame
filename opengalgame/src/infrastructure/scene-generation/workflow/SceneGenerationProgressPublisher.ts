import type { AgentProgressEvent } from '@infrastructure/ai/execution/AgentProgress'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type {
  SceneGenerationBudget,
  SceneGenerationExecution,
  SceneGenerationLiveProgress,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'

const LIVE_TOOLS: Record<string, true> = {
  listDirectory: true,
  readTextRange: true,
  writeText: true,
  replaceText: true
}

/** 生成进行中的节流发布。失败不升级，结束或取消后不再发布。 */
export class SceneGenerationProgressPublisher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private publishing = false
  private dirty = false
  private lastPublishedAt = 0
  private live: SceneGenerationLiveProgress | undefined
  private readonly publishIntervalMs: number
  private readonly idleNoticeMs: number
  private readonly onAbort: () => void

  constructor(
    private readonly options: {
      publish: (progress: SceneGenerationWorkflowProgress) => Promise<SceneGenerationExecution>
      budget: ExecutionBudget
      previousBudget: () => SceneGenerationBudget
      attempt: () => number
      now?: () => number
      signal?: AbortSignal
      publishIntervalMs?: number
      idleNoticeMs?: number
    }
  ) {
    this.publishIntervalMs = options.publishIntervalMs ?? 1500
    this.idleNoticeMs = options.idleNoticeMs ?? 30000
    this.onAbort = () => this.dispose()
    options.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  observe(event: AgentProgressEvent): void {
    if (this.stopped || this.options.signal?.aborted) return
    const activity = event.kind === 'tool-start' || event.kind === 'tool-end' ? 'tool' : 'model'
    const toolName =
      event.lastToolName && LIVE_TOOLS[event.lastToolName] ? event.lastToolName : undefined
    this.live = {
      activity,
      lastActivityAt: new Date(event.at).toISOString(),
      ...(toolName ? { lastToolName: toolName } : {}),
      ...(event.noNewInformationStreak === undefined
        ? {}
        : { noNewInformationStreak: event.noNewInformationStreak })
    }
    this.scheduleIdle()
    const elapsed = (this.options.now ?? Date.now)() - this.lastPublishedAt
    if (event.kind.endsWith('start') && elapsed >= 250) {
      this.queue(0)
      return
    }
    this.queue(Math.max(0, this.publishIntervalMs - elapsed))
  }

  /** 生成开始后即使还没有模型事件，也先发布一次生成中。 */
  start(): void {
    if (this.stopped) return
    const now = (this.options.now ?? Date.now)()
    this.live = { activity: 'waitingModel', lastActivityAt: new Date(now).toISOString() }
    this.queue(0)
    this.scheduleIdle()
  }

  dispose(): void {
    this.stopped = true
    this.dirty = false
    clearTimeout(this.timer)
    clearTimeout(this.idleTimer)
    this.timer = undefined
    this.idleTimer = undefined
    this.options.signal?.removeEventListener('abort', this.onAbort)
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.stopped || !this.live) return
      this.live = { ...this.live, activity: 'waitingModel' }
      this.queue(0)
    }, this.idleNoticeMs)
  }

  private queue(delayMs: number): void {
    if (this.stopped) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.publishing || !this.dirty || !this.live) return
    this.dirty = false
    this.publishing = true
    const progress: SceneGenerationWorkflowProgress = {
      step: 'generating',
      attempt: this.options.attempt(),
      budget: budgetSnapshot(this.options.budget, this.options.previousBudget()),
      live: this.live
    }
    try {
      await this.options.publish(progress)
      this.lastPublishedAt = (this.options.now ?? Date.now)()
    } catch {
      this.dirty = !this.stopped
    } finally {
      this.publishing = false
      if (this.stopped || this.options.signal?.aborted) {
        this.dispose()
        return
      }
      if (this.dirty) this.queue(this.publishIntervalMs)
    }
  }
}

function budgetSnapshot(
  budget: ExecutionBudget,
  previous: SceneGenerationBudget
): SceneGenerationBudget {
  const usage = budget.usage
  return {
    ...previous,
    modelCallsUsed: usage.modelAttempts,
    toolCallsUsed: usage.toolCalls,
    activeElapsedMs: usage.activeMs,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    totalTokens: usage.tokens,
    tokenLimit: budget.limits.tokens ?? previous.tokenLimit ?? null
  }
}
