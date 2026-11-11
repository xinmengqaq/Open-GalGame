import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunnableConfig } from '@langchain/core/runnables'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import {
  END,
  START,
  StateGraph,
  type CompiledStateGraph,
  type ExtractStateType,
  type ExtractUpdateType
} from '@langchain/langgraph'
import { tool, type ReactAgent } from 'langchain'
import { z } from 'zod'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { AgentStreamSubscriber } from '@infrastructure/ai/streaming/AgentStreamEvent'
import { studioMockFetch } from './mock-model'

process.env.LANGSMITH_TRACING ??= 'false'
const directory = dirname(fileURLToPath(import.meta.url))
const DebugState = z.object({ prompt: z.string().min(1), result: z.string().optional() })

class StudioDebugAgent implements Agent<string, string> {
  static readonly definition: AgentDefinition = {
    id: 'studio-debug',
    prompt: { agentId: 'studio-debug' },
    createTools: () => [
      tool(({ text }: { text: string }) => text, {
        name: 'echo',
        description: '回显本次调试文本',
        schema: z.object({ text: z.string() })
      })
    ],
    execution: {
      modelAttemptLimit: 4,
      toolCallLimit: 2,
      activeLimitMs: 30000,
      technicalRetryCount: 0
    }
  }
  constructor(private readonly executor: ReactAgent) {}

  /** 调用已有执行器并转换最终文本，不实现模型工具循环。 */
  async invoke(input: string, execution: AgentExecution): Promise<string> {
    const output = await this.executor.invoke(
      { messages: [{ role: 'user', content: input }] },
      { context: execution.context, signal: execution.signal }
    )
    const content = output.messages.at(-1)?.content
    if (typeof content === 'string') return content
    return (content ?? [])
      .flatMap((block) =>
        block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      )
      .join('')
  }
}

/** 导出 CLI 所需的最薄 compiled graph；模块加载只构造图，不调用模型。 */
export function createStudioDebugGraph(
  options: { onEvent?: AgentStreamSubscriber; console?: boolean } = {}
): CompiledStateGraph<
  ExtractStateType<typeof DebugState>,
  ExtractUpdateType<typeof DebugState, ExtractStateType<typeof DebugState>>,
  'agent' | '__start__'
> {
  return new StateGraph(DebugState)
    .addNode('agent', async (state, config: RunnableConfig) => {
      const prompt = z.string().min(1).parse(state.prompt)
      const executionId = randomUUID()
      const workspace = join(directory, '.workspace', executionId)
      await mkdir(workspace, { recursive: true })
      let failed: unknown
      try {
        const remote = process.env.STUDIO_MODEL_MODE === 'remote'
        const factory = new LangChainAgentFactoryImpl(
          new LangChainModelFactory(
            async () => ({
              providerId: 'openai-compatible',
              baseUrl: remote
                ? requiredEnvironment('STUDIO_BASE_URL')
                : 'https://studio.invalid/v1',
              model: remote ? requiredEnvironment('STUDIO_MODEL') : 'studio-mock',
              apiKey: remote ? requiredEnvironment('STUDIO_API_KEY') : 'studio-local-placeholder',
              contextWindow: 8000,
              maxOutputTokens: 256
            }),
            remote ? fetch : studioMockFetch
          ),
          new FilePromptLoader(join(directory, 'prompts')),
          { enabled: options.console ?? true }
        )
        const agent = await factory.create(StudioDebugAgent)
        const result = await AsyncLocalStorageProviderSingleton.runWithConfig(
          { callbacks: config.callbacks, tags: config.tags, metadata: config.metadata },
          () =>
            agent.invoke(prompt, {
              identity: { executionId },
              scope: { threadId: executionId },
              signal: config.signal,
              context: {
                budget: new ExecutionBudget({ modelAttempts: 4, toolCalls: 2, activeMs: 30000 }),
                workspace: { root: workspace, writable: false }
              },
              observation: { subscriptions: options.onEvent ? [{ onEvent: options.onEvent }] : [] }
            })
        )
        return { result }
      } catch (error) {
        failed = error
        throw error
      } finally {
        await releaseStudioWorkspace(workspace, failed)
      }
    })
    .addEdge(START, 'agent')
    .addEdge('agent', END)
    .compile()
}

/** 清理本次创建的调试目录，清理失败时保留原始执行失败。 */
async function releaseStudioWorkspace(workspace: string, failed: unknown): Promise<void> {
  try {
    await rm(workspace, { recursive: true, force: true })
  } catch (cleanup) {
    if (failed !== undefined) throw new AggregateError([failed, cleanup], 'Studio 调试清理失败')
    throw cleanup
  }
}

/** 从本机环境取得凭据和连接设置；失败只暴露固定安全消息。 */
function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value?.trim()) throw new Error('Studio 本机模型配置缺失')
  return value
}

export const graph = createStudioDebugGraph()
