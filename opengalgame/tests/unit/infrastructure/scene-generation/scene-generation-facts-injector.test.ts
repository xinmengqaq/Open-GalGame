import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import type { AnyAgentMiddleware } from 'langchain'
import { describe, expect, it } from 'vitest'

import {
  createContextFactsInjector,
  SCENE_FACTS_MESSAGE_ID
} from '@infrastructure/scene-generation/agents/context/ContextFactsInjector'

const BASE_SYSTEM_PROMPT = '你是场景编剧，按工具契约写出候选脚本。'

/** 与装配器结构一致的最小事实文本，便于断言字段名不会进入系统消息。 */
const FACTS_JSON = JSON.stringify({
  mode: 'repair',
  target: {
    projectId: 'project-1',
    sceneId: 'scene-1',
    entryFile: 'game/scene/start.txt'
  },
  candidateSnapshotId: 'candidate-1',
  diagnostics: { issues: [] },
  commandLocations: [{ sequence: 0, filePath: 'game/scene/start.txt', line: 1 }],
  assetBindings: [],
  budget: {},
  historySummary: ''
})

interface ModelRequestLike {
  messages: BaseMessage[]
  systemMessage: SystemMessage
  runtime: { context: Record<string, unknown> }
}

type WrapModelCall = (
  request: ModelRequestLike,
  handler: (request: ModelRequestLike) => Promise<unknown>
) => Promise<unknown>

/**
 * @returns 可直接调用并捕获下一跳请求的模型包装钩子。
 * @throws {Error} 中间件没有声明 wrapModelCall。
 */
function wrapModelCallOf(middleware: AnyAgentMiddleware): WrapModelCall {
  const hook = middleware.wrapModelCall
  if (hook === undefined) throw new Error('中间件没有声明 wrapModelCall')
  return hook as unknown as WrapModelCall
}

/** 事实消息仍作为独立消息进入请求；系统消息只带基础提示词与运行状态。 */
function requestWithFacts(context: Record<string, unknown> = {}): ModelRequestLike {
  return {
    messages: [new HumanMessage({ id: SCENE_FACTS_MESSAGE_ID, content: FACTS_JSON })],
    systemMessage: new SystemMessage(BASE_SYSTEM_PROMPT),
    runtime: { context: { executionMode: 'repair', writtenFiles: [], ...context } }
  }
}

describe('场景事实注入中间件', () => {
  it('事实只作为受保护消息出现一次，系统消息不再复制事实 JSON 且保留运行状态', async () => {
    const request = requestWithFacts()
    const captured: ModelRequestLike[] = []
    const result = await wrapModelCallOf(createContextFactsInjector())(request, async (next) => {
      captured.push(next)
      return 'model-response'
    })

    expect(result).toBe('model-response')
    expect(captured).toHaveLength(1)
    const sent = captured[0]!
    const factsMessages = sent.messages.filter((message) => message.id === SCENE_FACTS_MESSAGE_ID)
    expect(factsMessages).toHaveLength(1)
    expect(factsMessages[0]?.text).toBe(FACTS_JSON)
    expect(sent.systemMessage.text).toContain(BASE_SYSTEM_PROMPT)
    expect(sent.systemMessage.text).toContain('[运行状态]')
    expect(sent.systemMessage.text).toContain('候选：源候选可读（修复起点）')
    for (const field of ['commandLocations', 'assetBindings', 'candidateSnapshotId', 'diagnostics'])
      expect(sent.systemMessage.text).not.toContain(field)
    expect(sent.systemMessage.text).not.toContain(FACTS_JSON)
    const copies = [
      sent.systemMessage.text,
      ...sent.messages.map((message) => message.text)
    ].filter((text) => text.includes(FACTS_JSON))
    expect(copies).toHaveLength(1)
  })

  it('缺少受保护的事实消息时仍拒绝调用模型', async () => {
    let handlerCalled = false
    const request: ModelRequestLike = {
      messages: [new HumanMessage('只有用户输入')],
      systemMessage: new SystemMessage(BASE_SYSTEM_PROMPT),
      runtime: { context: { executionMode: 'repair' } }
    }

    await expect(
      wrapModelCallOf(createContextFactsInjector())(request, async () => {
        handlerCalled = true
        return 'model-response'
      })
    ).rejects.toThrow('当前场景事实缺失')
    expect(handlerCalled).toBe(false)
  })

  it('普通生成轮同样保留运行状态提示且不复制事实', async () => {
    const request = requestWithFacts({ executionMode: 'generate' })
    const captured: ModelRequestLike[] = []
    await wrapModelCallOf(createContextFactsInjector())(request, async (next) => {
      captured.push(next)
      return 'model-response'
    })

    const systemText = captured[0]?.systemMessage.text ?? ''
    expect(systemText).toContain('[运行状态]')
    expect(systemText).toContain('候选：未写出')
    expect(systemText).toContain('request_clarification')
    expect(systemText).not.toContain('commandLocations')
    expect(systemText).not.toContain(FACTS_JSON)
  })
})
