import { randomUUID } from 'node:crypto'
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { ProtocolEvent } from '@langchain/langgraph/stream'
import { isGraphInterrupt } from '@langchain/langgraph'
import type {
  AgentRunStatus,
  AgentStreamAssociation,
  AgentStreamEvent,
  AgentTokenUsage
} from './AgentStreamEvent'

type ModelCallRecord = {
  started: number
  name?: string
  messageId?: string
  agentId?: string
  announced: boolean
}
type ToolCallRecord = {
  started: number
  name?: string
  namespace: readonly string[]
  association: AgentStreamAssociation
  toolCallId: string
}
type ChildRecord = {
  agentId: string
  runId: string
  started: number
  parentRunId: string
  toolCallId?: string
}

export class LangChainEventStreamAdapter {
  private sequence = 0
  private callbacksEnabled = false
  private released = false
  private readonly runId = randomUUID()
  private readonly started = performance.now()
  private readonly models = new Map<string, ModelCallRecord>()
  private readonly tools = new Map<string, ToolCallRecord>()
  private readonly children = new Map<string, ChildRecord>()
  private readonly toolRuns = new Map<string, string>()
  private readonly interruptedTools = new Set<string>()

  /**
   * @param executionId - 调用方提供的执行身份。
   * @param modelName - 工厂配置的无密钥模型名称。
   */
  constructor(
    private readonly executionId: string,
    private readonly agentId: string,
    private readonly textDeltas: boolean,
    private readonly modelName?: string
  ) {}

  /** 为网络请求前失败与技术重试补齐模型生命周期，不读取提示词或结果。 */
  callbacks(
    dispatch: (event: AgentStreamEvent) => void
  ): Pick<
    BaseCallbackHandler,
    | 'handleChatModelStart'
    | 'handleLLMError'
    | 'handleToolStart'
    | 'handleToolError'
    | 'handleToolEnd'
  > {
    this.callbacksEnabled = true
    return {
      handleToolStart: (_tool, _input, runId, _parent, _tags, metadata, _name, toolCallId) => {
        if (this.released || !toolCallId) return
        const namespace = stringOf(metadata?.langgraph_checkpoint_ns)?.split('|') ?? []
        this.toolRuns.set(runId, JSON.stringify([namespace, toolCallId]))
      },
      handleToolError: (error, runId) => {
        const key = this.toolRuns.get(runId)
        this.toolRuns.delete(runId)
        if (key && isGraphInterrupt(error)) this.interruptedTools.add(key)
      },
      handleToolEnd: (_output, runId) => {
        this.toolRuns.delete(runId)
      },
      handleChatModelStart: (_model, _messages, runId, _parentRunId, _extra, _tags, metadata) => {
        if (this.released || this.models.has(runId)) return
        const agentId = stringOf(metadata?.lc_agent_name) ?? this.agentId
        const modelName = stringOf(metadata?.ls_model_name) ?? this.modelName
        const announced = agentId === this.agentId
        this.models.set(runId, { started: performance.now(), name: modelName, agentId, announced })
        if (!announced) return
        dispatch({
          ...this.base(),
          runId,
          parentRunId: this.runId,
          type: 'model',
          status: 'started',
          modelName
        })
      },
      handleLLMError: (_error, runId) => {
        const record = this.models.get(runId)
        if (!record) return
        this.models.delete(runId)
        if (!record.announced)
          dispatch({
            ...this.base(),
            agentId: record.agentId ?? this.agentId,
            runId,
            type: 'model',
            status: 'started',
            modelName: record.name
          })
        dispatch({
          ...this.base(),
          runId,
          agentId: record.agentId ?? this.agentId,
          parentRunId: this.runId,
          type: 'model',
          status: 'failed',
          modelName: record.name,
          durationMs: performance.now() - record.started,
          error: { category: 'model', message: '模型调用失败' }
        })
      }
    }
  }

  start(): AgentStreamEvent {
    return { ...this.base(), type: 'run', status: 'started' }
  }

  /** 在完整 Agent 调用及必要结算结束后创建唯一根终态。 */
  finish(status: Exclude<AgentRunStatus, 'started'>): AgentStreamEvent {
    return {
      ...this.base(),
      type: 'run',
      status,
      durationMs: performance.now() - this.started,
      ...(status === 'failed'
        ? { error: { category: 'execution' as const, message: 'Agent 执行失败' } }
        : {})
    }
  }

  /**
   * 适配固定 v3 协议；不向订阅者传出原始状态、参数、结果或错误。
   * @returns 筛选后的通用事件；无对应观察事实时为空数组。
   */
  adapt(event: ProtocolEvent): AgentStreamEvent[] {
    const payload = recordOf(event.params.data)
    if (event.method === 'tasks') return this.identifyChild(event, payload)
    if (event.method === 'messages') return this.message(event, payload)
    if (event.method === 'tools') return this.tool(event, payload)
    if (event.method === 'lifecycle') return this.lifecycle(event, payload)
    if (event.method === 'updates')
      return [
        {
          ...this.base(event),
          type: 'state',
          channel: 'updates',
          node: event.params.node,
          status: 'updated'
        }
      ]
    if (event.method === 'input' && payload.event === 'requested')
      return [{ ...this.base(event), type: 'state', channel: 'input', status: 'interrupted' }]
    return []
  }

  /** 释放尚未闭合的调用关联，不累计事件历史。 */
  release(): void {
    this.released = true
    this.models.clear()
    this.tools.clear()
    this.children.clear()
    this.toolRuns.clear()
    this.interruptedTools.clear()
  }

  /** 按命名空间关联执行位置，使用本次运行内递增序号。 */
  private base(event?: ProtocolEvent): AgentStreamAssociation {
    const namespace = event?.params.namespace
    const child = this.findChild(namespace)
    return {
      executionId: this.executionId,
      agentId: child?.agentId ?? this.agentId,
      runId: child?.runId ?? this.runId,
      timestamp: event?.params.timestamp ?? Date.now(),
      sequence: ++this.sequence,
      ...(event ? { sourceSequence: event.seq, namespace: [...event.params.namespace] } : {}),
      ...(child ? { parentRunId: child.parentRunId } : {})
    }
  }

  /** 将模型消息关联到真实模型调用，只输出普通文本。 */
  private message(event: ProtocolEvent, payload: Record<string, unknown>): AgentStreamEvent[] {
    const runId = stringOf(payload.run_id)
    if (!runId) return []
    let call = this.models.get(runId)
    if (payload.event === 'message-start') {
      if (payload.role !== undefined && payload.role !== 'assistant' && payload.role !== 'ai')
        return []
      if (this.callbacksEnabled && !call) return []
      const existed = call?.announced === true
      call ??= { started: performance.now(), name: this.modelName, announced: false }
      call.announced = true
      call.messageId = stringOf(payload.id)
      this.models.set(runId, call)
      if (existed) return []
      const base = this.base(event)
      return [
        {
          ...base,
          runId,
          parentRunId: base.runId,
          agentId: call.agentId ?? base.agentId,
          messageId: call.messageId,
          type: 'model',
          status: 'started',
          modelName: call.name
        }
      ]
    }
    if (!call) return []
    const base = this.base(event)
    const association = {
      ...base,
      runId,
      parentRunId: base.runId,
      agentId: call.agentId ?? base.agentId,
      messageId: call.messageId
    }
    if (payload.event === 'message-finish' || payload.event === 'error') {
      this.models.delete(runId)
      const failed = payload.event === 'error'
      const usage = readUsage(payload.usage)
      return [
        {
          ...association,
          type: 'model',
          status: failed ? 'failed' : 'succeeded',
          modelName: call.name,
          durationMs: performance.now() - call.started,
          ...(usage ? { usage } : {}),
          ...(failed ? { error: { category: 'model' as const, message: '模型调用失败' } } : {})
        }
      ]
    }
    const delta = recordOf(payload.delta)
    if (
      this.textDeltas &&
      payload.event === 'content-block-delta' &&
      delta.type === 'text-delta' &&
      typeof delta.text === 'string'
    )
      return [{ ...association, type: 'text', text: delta.text }]
    return []
  }

  /** 工具调用按命名空间与调用标识分开，进度不携带输出。 */
  private tool(event: ProtocolEvent, payload: Record<string, unknown>): AgentStreamEvent[] {
    const toolCallId = stringOf(payload.tool_call_id)
    if (!toolCallId) return []
    const key = JSON.stringify([event.params.namespace, toolCallId])
    if (payload.event === 'tool-started')
      this.tools.set(key, {
        started: performance.now(),
        name: stringOf(payload.tool_name),
        namespace: event.params.namespace,
        association: this.base(event),
        toolCallId
      })
    const call = this.tools.get(key)
    if (!call) return []
    const status =
      payload.event === 'tool-started'
        ? 'started'
        : payload.event === 'tool-output-delta'
          ? 'progress'
          : payload.event === 'tool-error' || recordOf(payload.output).status === 'error'
            ? this.interruptedTools.has(key)
              ? 'interrupted'
              : 'failed'
            : payload.event === 'tool-finished'
              ? 'succeeded'
              : undefined
    if (!status) return []
    if (status === 'succeeded' || status === 'failed' || status === 'interrupted') {
      this.tools.delete(key)
      this.interruptedTools.delete(key)
    }
    return [
      {
        ...this.base(event),
        runId: call.association.runId,
        agentId: call.association.agentId,
        parentRunId: call.association.parentRunId,
        type: 'tool',
        toolCallId,
        toolName: call.name,
        status,
        ...(status === 'succeeded' || status === 'failed' || status === 'interrupted'
          ? { durationMs: performance.now() - call.started }
          : {}),
        ...(status === 'failed'
          ? { error: { category: 'tool' as const, message: '工具调用失败' } }
          : {})
      }
    ]
  }

  /** 只将库确认由具名 Agent 的工具调用产生的子运行标为子 Agent。 */
  private lifecycle(event: ProtocolEvent, payload: Record<string, unknown>): AgentStreamEvent[] {
    if (event.params.namespace.length === 0) return []
    const key = JSON.stringify(event.params.namespace)
    const cause = recordOf(payload.cause)
    if (
      payload.event === 'started' &&
      cause.type === 'toolCall' &&
      typeof payload.graph_name === 'string'
    ) {
      return this.startChild(event, payload.graph_name, stringOf(cause.tool_call_id))
    }
    const child = this.children.get(key)
    if (!child) return []
    const status =
      payload.event === 'completed'
        ? 'succeeded'
        : payload.event === 'failed'
          ? 'failed'
          : payload.event === 'interrupted'
            ? 'interrupted'
            : undefined
    if (!status) return []
    const association = this.base(event)
    this.children.delete(key)
    return [
      {
        ...association,
        type: 'run',
        status,
        toolCallId: child.toolCallId,
        durationMs: performance.now() - child.started
      }
    ]
  }

  /** 只读取库的具名 Agent 元数据，不把整个任务载荷交给观察者。 */
  private identifyChild(
    event: ProtocolEvent,
    payload: Record<string, unknown>
  ): AgentStreamEvent[] {
    if (event.params.namespace.length === 0) return []
    const agentId = stringOf(recordOf(payload.metadata).lc_agent_name)
    const parent = this.findChild(event.params.namespace)
    if (!agentId || agentId === (parent?.agentId ?? this.agentId)) return []
    const tool = [...this.tools.values()].find(
      (call) => JSON.stringify(call.namespace) === JSON.stringify(event.params.namespace)
    )
    return this.startChild(event, agentId, tool?.toolCallId)
  }

  /** 建立已确认的子运行身份；相同命名空间只记录一次开始。 */
  private startChild(
    event: ProtocolEvent,
    agentId: string,
    toolCallId?: string
  ): AgentStreamEvent[] {
    const namespace = event.params.namespace
    const key = JSON.stringify(namespace)
    if (this.children.has(key)) return []
    const parent = this.findChild(namespace.slice(0, -1))
    this.children.set(key, {
      agentId,
      runId: randomUUID(),
      started: performance.now(),
      parentRunId: parent?.runId ?? this.runId,
      toolCallId
    })
    return [{ ...this.base(event), type: 'run', status: 'started', toolCallId }]
  }

  /** 从最深的已确认命名空间关联模型或工具，普通节点不建立身份。 */
  private findChild(namespace?: readonly string[]): ChildRecord | undefined {
    if (!namespace) return undefined
    for (let length = namespace.length; length > 0; length -= 1) {
      const child = this.children.get(JSON.stringify(namespace.slice(0, length)))
      if (child) return child
    }
    return undefined
  }
}

/** 在协议边界缩窄对象，未知字段不透传。 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 只接受库提供的非空字符串标识。 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 只保留供应商实际返回的三种计量，缺失时省略。 */
function readUsage(value: unknown): AgentTokenUsage | undefined {
  const raw = recordOf(value)
  const usage: AgentTokenUsage = {}
  for (const [source, target] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens']
  ] as const) {
    const count = raw[source]
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) usage[target] = count
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}
