import { failureOf } from '@presentation/feedback/failure'

import type {
  GenerationActionFailure,
  GenerationActionKind
} from './generationPresentation'

export type GenerationSelectionToken = {
  readonly scope: string
  /** 发起请求时当前视图的操作；还没有任何操作时为 null。 */
  readonly operationId: string | null
  /** 同一操作切走又切回也会递增；迟到结果不能跨过任何一次选择变化。 */
  readonly epoch: number
}

/** 工程/场景的唯一作用域键；操作身份只在同一键内比较。 */
export function generationScopeKey(projectId: string, sceneId: string): string {
  return `${projectId}|${sceneId}`
}

/**
 * 当前视图的身份与代次。只保存“作者此刻选的是哪个操作”，不保存状态事实；
 * 状态仍由 useGenerationStatus 的 statusRef/state 唯一持有。
 *
 * 每次操作切换（包括切走再切回）递增 epoch，异步结果必须同时匹配作用域、
 * 操作和代次才能写回。作用域切换会立即清空显式选择，避免跨场景串用。
 */
export class GenerationSelectionSession {
  private scopeKey = ''
  private operationId: string | null = null
  private epoch = 0
  private pinnedOperationId: string | null = null
  /**
   * 用户显式切换视图的次数：切场景或从发现列表选任务时递增。
   * 被动状态落地（首次读取、重载、进度）只推进 epoch，不改变它，
   * 因此已经派发的动作能区分“读回更新”与“作者真的切走了”。
   */
  private intentRevision = 0

  /** 由渲染期的 projectId/sceneId 调用；只在真正变化时生效。 */
  setScope(scope: string): void {
    if (this.scopeKey === scope) return
    this.scopeKey = scope
    this.operationId = null
    this.epoch += 1
    this.pinnedOperationId = null
    this.intentRevision += 1
  }

  /** 权威状态已经切到某个操作时同步身份；返回是否发生了切换。 */
  observe(operationId: string | null): boolean {
    if (this.operationId === operationId) return false
    this.operationId = operationId
    this.epoch += 1
    return true
  }

  /** 发起动作时捕获；只有作者显式切换才改变。 */
  explicitIntent(): number {
    return this.intentRevision
  }

  token(): GenerationSelectionToken {
    return { scope: this.scopeKey, operationId: this.operationId, epoch: this.epoch }
  }

  isCurrent(token: GenerationSelectionToken): boolean {
    return (
      token.scope === this.scopeKey &&
      token.operationId === this.operationId &&
      token.epoch === this.epoch
    )
  }

  /** 作者从发现列表显式选择的任务；只在此后按身份刷新重载。 */
  pin(operationId: string): void {
    this.pinnedOperationId = operationId
    this.intentRevision += 1
  }

  /**
   * 作者动作成功并明确进入另一个操作（启动、修复重跑、分叉）。
   * 只登记显式意图，不改变当前操作；随后由 applyStatus 观察新操作。
   */
  markExplicitSwitch(): void {
    this.intentRevision += 1
  }

  clearPin(): void {
    this.pinnedOperationId = null
  }

  /**
   * 只有当前视图仍是显式选择的任务时才返回 pin；作者已经进入其它操作时
   * 丢弃旧 pin，让重载回到最新事实，避免永远锁在旧任务上。
   */
  pinnedForCurrentView(): string | null {
    if (
      this.pinnedOperationId !== null &&
      this.pinnedOperationId !== this.operationId
    ) {
      this.pinnedOperationId = null
    }
    return this.pinnedOperationId
  }
}

export type GenerationActionRequest = {
  readonly id: number
  readonly key: string
  readonly kind: GenerationActionKind
  readonly scope: string
  readonly operationId: string | null
  /** 场景级动作（启动新生成）不随读回的操作身份变化而重复登记。 */
  readonly scopeLevel: boolean
}

/**
 * 正在进行的动作请求。阻止同一目标上的重复变更，但不靠禁用界面代替
 * 身份校验；不同操作/场景的请求可以并存，响应各自按代次丢弃。
 * 启动是场景级动作：读回把视图从空态切到某个旧操作时，不能因此再发一次 start。
 */
export class GenerationActionRequestRegistry {
  private nextId = 1
  private readonly active = new Map<string, GenerationActionRequest>()

  begin(
    token: GenerationSelectionToken,
    kind: GenerationActionKind
  ): GenerationActionRequest | null {
    const scopeLevel = kind === 'start'
    const key = scopeLevel ? sceneStartKey(token.scope) : defaultRequestKey(token)
    if (this.active.has(key)) return null
    const request: GenerationActionRequest = {
      id: this.nextId++,
      key,
      kind,
      scope: token.scope,
      operationId: token.operationId,
      scopeLevel
    }
    this.active.set(key, request)
    return request
  }

  end(request: GenerationActionRequest): void {
    if (this.active.get(request.key)?.id === request.id) {
      this.active.delete(request.key)
    }
  }

  /** 当前视图应显示的忙态：只认同一作用域；场景级启动对任意当前操作都算忙。 */
  visibleKind(scope: string, operationId: string | null): GenerationActionKind | null {
    for (const request of this.active.values()) {
      if (request.scope !== scope) continue
      if (request.scopeLevel || request.operationId === operationId) return request.kind
    }
    return null
  }
}

function sceneStartKey(scope: string): string {
  return `${scope}|@scene-start`
}

function defaultRequestKey(token: GenerationSelectionToken): string {
  return `${token.scope}|${token.operationId ?? '@none'}`
}

export type PerformGenerationActionOptions<T> = {
  readonly registry: GenerationActionRequestRegistry
  readonly token: GenerationSelectionToken
  readonly kind: GenerationActionKind
  readonly isCurrent: (token: GenerationSelectionToken) => boolean
  readonly request: () => Promise<T>
  /** 仅当发起时的身份与代次仍是当前选择时调用。 */
  readonly onResult: (result: T) => void
  /** 仅当发起时的身份与代次仍是当前选择时调用。 */
  readonly onFailure: (failure: GenerationActionFailure, error: unknown) => void
  /** 请求成功但选择已变化：结果必须丢弃；只允许收起仅属于该次请求的本地状态。 */
  readonly onStale?: (result: T) => void
  readonly onStart?: (request: GenerationActionRequest) => void
  readonly onSettled?: (request: GenerationActionRequest) => void
  readonly onChange?: () => void
}

/**
 * 所有动作共用的发起/收割控制流：先登记目标，响应回来时只有发起身份与
 * 代次仍等于当前选择才交给消费者；切走、切回、切场景都会让迟到结果作废。
 * 无论结果是否采用，结束登记只撤销本次请求，不会清掉后来请求的忙态。
 */
export async function performGenerationAction<T>({
  registry,
  token,
  kind,
  isCurrent,
  request,
  onResult,
  onFailure,
  onStale,
  onStart,
  onSettled,
  onChange
}: PerformGenerationActionOptions<T>): Promise<'busy' | 'settled'> {
  const active = registry.begin(token, kind)
  if (!active) return 'busy'
  onChange?.()
  onStart?.(active)
  try {
    const result = await request()
    if (isCurrent(token)) onResult(result)
    else onStale?.(result)
  } catch (error) {
    if (!isCurrent(token)) return 'settled'
    const failure = failureOf(error)
    onFailure(
      { kind, message: failure.msg, unverified: false, code: failure.code },
      error
    )
  } finally {
    registry.end(active)
    onSettled?.(active)
    onChange?.()
  }
  return 'settled'
}

/** 作用域错误只在发起时的视图仍被选中时显示；切走后返回 null。 */
export function visibleActionFailure<T extends {
  scope: string
  operationId: string | null
  epoch: number
  value: GenerationActionFailure
}>(
  record: T | null,
  isCurrent: (token: GenerationSelectionToken) => boolean
): GenerationActionFailure | null {
  if (!record) return null
  return isCurrent({
    scope: record.scope,
    operationId: record.operationId,
    epoch: record.epoch
  })
    ? record.value
    : null
}
