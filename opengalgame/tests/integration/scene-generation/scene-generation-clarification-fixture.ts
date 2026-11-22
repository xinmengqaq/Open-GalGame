import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import {
  generationFixture,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'
import { streamingFetch } from '../ai/streamingFetch'

export type ClarificationQuestionFixture = {
  prompt: string
  detail?: string
  options: readonly { label: string; description: string }[]
}

/**
 * 验收夹具不开放写前 requestClarification 入口；本装配只替换模型响应，
 * 工程、Skills、解析、检查点、Git、恢复与候选写入全部走真实实现。
 * 首轮用户在事实消息后调用 requestClarification，回答后的生成轮按事实写入候选。
 */
export async function clarificationAnswerFixture(
  questions: readonly ClarificationQuestionFixture[]
): Promise<GenerationFixture> {
  const base = await generationFixture()
  const bodies: GenerationFixture['bodies'] = []
  let asked = false
  let writes = 0
  const fetcher = streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    if (String(init?.body).includes('Context Extraction Assistant'))
      return Response.json({
        id: 'summary-test',
        object: 'chat.completion',
        created: 1,
        model: 'test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '保留车站道别创作摘要。' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      })
    const last = body.messages.at(-1)
    let call: { name: string; arguments: unknown } | undefined
    if (last?.role === 'user') {
      if (!asked) {
        asked = true
        call = { name: 'requestClarification', arguments: { questions } }
      } else {
        writes += 1
        call = {
          name: 'writeCandidate',
          arguments: {
            path: 'game/scene/start.txt',
            expectedRevision: expectedRevisionOf(body.messages),
            content: validScript
          }
        }
      }
    }
    return Response.json({
      object: 'chat.completion',
      created: 1,
      model: 'test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: call ? null : '已结束本轮。',
            ...(call
              ? {
                  tool_calls: [
                    {
                      id: 'call-answer-fixture',
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                    }
                  ]
                }
              : {})
          },
          finish_reason: call ? 'tool_calls' : 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    })
  })
  const config = {
    ...base.config,
    fetcher,
    dispatch: (job: () => Promise<void>) => {
      base.jobs.push(job)
    }
  }
  const app = await createSceneGeneration(config)
  return { ...base, app, config, bodies, writes: () => writes }
}

/** 从当前 Pi 运行的 facts 用户消息读取 draft.revision，模拟模型按事实写入。 */
function expectedRevisionOf(messages: Array<{ role: string; content?: string | unknown }>): string {
  const facts = messages
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .at(-1)
  const matched = facts?.match(/"revision"\s*:\s*"([^"]+)"/)
  return matched?.[1] ?? 'absent'
}

/** OpenAI-compatible 请求可能把文本包成内容块；只拼接文本块，不解释其他类型。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) =>
      block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
        ? [block.text]
        : []
    )
    .join('')
}

/**
 * 只替换模型响应以产生真实 reportBlocked 工具调用；工程、Skills、解析、检查点、
 * Git 与恢复仍走真实 createSceneGeneration。用于验证写前主动阻塞不产生候选。
 */
export async function blockedWriteFixture(reason: string): Promise<GenerationFixture> {
  const base = await generationFixture()
  const bodies: GenerationFixture['bodies'] = []
  const fetcher = streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    if (String(init?.body).includes('Context Extraction Assistant'))
      return Response.json({
        id: 'summary-test',
        object: 'chat.completion',
        created: 1,
        model: 'test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '保留车站道别创作摘要。' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      })
    const last = body.messages.at(-1)
    const call =
      last?.role === 'user'
        ? { name: 'reportBlocked', arguments: { reason } }
        : undefined
    return Response.json({
      object: 'chat.completion',
      created: 1,
      model: 'test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: call ? null : '已结束本轮。',
            ...(call
              ? {
                  tool_calls: [
                    {
                      id: 'call-blocked-fixture',
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                    }
                  ]
                }
              : {})
          },
          finish_reason: call ? 'tool_calls' : 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    })
  })
  const config = {
    ...base.config,
    fetcher,
    dispatch: (job: () => Promise<void>) => {
      base.jobs.push(job)
    }
  }
  const app = await createSceneGeneration(config)
  return { ...base, app, config, bodies }
}
