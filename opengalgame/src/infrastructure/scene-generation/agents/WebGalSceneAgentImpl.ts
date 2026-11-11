import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { createMiddleware, providerStrategy, type AnyAgentMiddleware, type ReactAgent } from 'langchain'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { agentRunContextSchema } from '@infrastructure/ai/agents/AgentRunContextSchema'
import { beginReadLedger } from '@infrastructure/ai/execution/ReadLedger'
import {
  beginWrittenFileLedger,
  writtenFileFacts
} from '@infrastructure/ai/execution/writtenFileLedger'
import { createWorkspaceFileTools } from '@infrastructure/ai/tools/WorkspaceFileTools'
import {
  SCENE_RESULT_TOOL_NAME,
  sceneAgentOutputSchema,
  type WebGalSceneAgentInput,
  type WebGalSceneAgentOutput,
  type WebGalSceneMemoryMessage
} from './WebGalSceneAgentTypes'
import { SceneGenerationContextAssemblerImpl } from './context/SceneGenerationContextAssemblerImpl'
import {
  createContextFactsInjector,
  createSceneToolErrorMiddleware,
  SCENE_FACTS_MESSAGE_ID
} from './context/ContextFactsInjector'
import { createSceneStructuredChannel, structuredChannelMode } from './sceneStructuredChannel'

export class WebGalSceneAgentImpl implements Agent<WebGalSceneAgentInput, WebGalSceneAgentOutput> {
  static readonly definition: AgentDefinition = {
    id: 'webgal-scene',
    prompt: { agentId: 'webgal-scene' },
    createTools: createWorkspaceFileTools,
    execution: {},
    responseFormat: providerStrategy({
      schema: sceneAgentOutputSchema,
      strict: false
    }),
    middleware: [
      createFinalizeOnlyTools(),
      createSceneStructuredChannel(),
      createContextFactsInjector(),
      createSceneToolErrorMiddleware()
    ]
  }

  /** 执行器由既有统一工厂创建，业务智能体不构造模型或工具循环。 */
  constructor(private readonly executor: ReactAgent) {}

  /** 将生成、修正与收尾转换为相同执行器的输入，只返回结构化候选说明。 */
  async invoke(
    input: WebGalSceneAgentInput,
    execution: AgentExecution
  ): Promise<WebGalSceneAgentOutput> {
    const facts = new HumanMessage({
      id: SCENE_FACTS_MESSAGE_ID,
      content: new SceneGenerationContextAssemblerImpl().assemble(input)
    })
    beginWrittenFileLedger(execution.context.budget)
    beginReadLedger(execution.context.budget)
    const result = await this.executor.invoke(
      {
        messages: [
          ...(input.memoryMessages ?? []).map((message) =>
            message.role === 'user' ? new HumanMessage(message) : new AIMessage(message)
          ),
          facts
        ]
      },
      {
        signal: execution.signal,
        context: {
          ...execution.context,
          requiredMessageIds: [SCENE_FACTS_MESSAGE_ID],
          executionMode: input.mode
        },
        configurable: { thread_id: execution.scope.threadId }
      }
    )
    const parsedOutput = sceneAgentOutputSchema.safeParse(result.structuredResponse)
    if (result.structuredResponse === undefined) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '模型没有提交结构化结果',
        diagnosticCategory: 'missing-structured-result'
      })
    }
    if (!parsedOutput.success) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '模型输出不符合约定',
        cause: parsedOutput.error,
        diagnosticCategory: 'structured-output'
      })
    }
    const output = parsedOutput.data
    const writtenFiles = new Set(
      writtenFileFacts(execution.context.budget).map((fact) => fact.path)
    )
    const declaredFiles = new Set(output.writtenFiles)
    const entryPath = `${input.execution.source.sceneDirectory}/${input.execution.source.entryFile}`
    if (input.mode === 'finalize') {
      if (output.action === 'request_clarification')
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '收尾阶段不能提问'
        })
      if (!sameFiles(declaredFiles, new Set(input.writtenFiles ?? [])))
        throw inconsistentFiles()
    } else if (output.action === 'submit_scene_result') {
      if (!writtenFiles.has(entryPath))
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '智能体未通过文件工具实际写入候选脚本',
          diagnosticCategory: 'completion'
        })
      if (!sameFiles(declaredFiles, writtenFiles)) throw inconsistentFiles()
    } else if (output.action === 'report_blocked') {
      if (!sameFiles(declaredFiles, writtenFiles)) throw inconsistentFiles()
    } else if (declaredFiles.size > 0 || writtenFiles.size > 0) {
      throw inconsistentFiles()
    }
    const knownIds = new Set(input.memoryMessages?.map((message) => message.id))
    const memoryMessages: WebGalSceneMemoryMessage[] = result.messages.flatMap((message) => {
      if (message.additional_kwargs.lc_source === 'summarization')
        return [
          {
            id: `summary-${execution.identity.executionId}`,
            role: 'user' as const,
            content: message.text
          }
        ]
      if (message.id && knownIds.has(message.id))
        return [
          {
            id: message.id,
            role: message instanceof HumanMessage ? ('user' as const) : ('assistant' as const),
            content: message.text
          }
        ]
      return []
    })
    memoryMessages.push(
      {
        id: `request-${execution.identity.executionId}`,
        role: 'user',
        content: input.execution.inputSnapshot.prompts.map((prompt) => prompt.body).join('\n')
      },
      {
        id: `summary-${execution.identity.executionId}-${input.execution.budget.correctionsUsed}`,
        role: 'assistant',
        content: output.summary
      }
    )
    return { ...output, writtenFiles: [...writtenFiles], memoryMessages }
  }
}

/** 收尾阶段只允许提交或报告阻塞；原生通道没有提交工具，任何工具调用都不执行。 */
export function createFinalizeOnlyTools(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'webgalFinalizeTools',
    contextSchema: agentRunContextSchema,
    wrapToolCall: async (request, handler) => {
      if (request.runtime.context.executionMode !== 'finalize') return handler(request)
      const mode = structuredChannelMode(request.runtime.context)
      if (mode === 'json_schema' || mode === 'json_object')
        return new ToolMessage({
          content: '收尾阶段不能调用工具；请直接输出符合契约的 JSON',
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
          status: 'error'
        })
      if (request.toolCall.name === SCENE_RESULT_TOOL_NAME) return handler(request)
      return new ToolMessage({
        content: '收尾阶段只能提交最终结果或报告阻塞，不能再调用文件工具',
        tool_call_id: request.toolCall.id ?? '',
        name: request.toolCall.name,
        status: 'error'
      })
    }
  })
}

/** 两个文件集合完全一致：数量相同且逐项包含。 */
function sameFiles(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...right].every((path) => left.has(path))
}

function inconsistentFiles(): AppException {
  return new AppException({
    code: ErrorCodes.operationConflict,
    msg: '智能体完成结果与实际候选脚本写入不一致',
    diagnosticCategory: 'structured-output'
  })
}
