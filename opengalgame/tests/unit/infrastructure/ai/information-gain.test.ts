import { ProviderStrategy, ToolMessage, ToolStrategy } from 'langchain'
import { describe, expect, it } from 'vitest'

import { z } from 'zod'

import { InformationGainTracker } from '@infrastructure/ai/execution/InformationGainTracker'
import { hasStructuredSubmission } from '@infrastructure/ai/middleware/informationGainMiddleware'

describe('信息增益', () => {
  it('同一调用和同一结果累计无进展', () => {
    const tracker = new InformationGainTracker()
    tracker.observe('read:a', 'same')
    tracker.observe('read:a', 'same')
    expect(tracker.consecutiveNoGain).toBe(1)
    expect(tracker.redundantRepeats).toBe(1)
    tracker.observe('read:a', 'same')
    expect(tracker.needsNudge()).toBe(true)
    expect(tracker.takeNudge()).toBe(true)
    expect(tracker.takeNudge()).toBe(false)
    expect(tracker.shouldStop()).toBe(false)
  })

  it('同一批六条重复结果只结算一次', () => {
    const tracker = new InformationGainTracker()
    tracker.observe('echo:same', 'echoed')
    const facts = Array.from({ length: 6 }, () => ({
      key: 'echo:same',
      signature: 'echoed',
      repeat: tracker.note('echo:same', 'echoed')
    }))
    expect(facts.filter((fact) => fact.repeat)).toHaveLength(6)
    tracker.settleRound(facts)
    expect(tracker.consecutiveNoGain).toBe(1)
    expect(tracker.redundantRepeats).toBe(1)
    expect(tracker.needsNudge()).toBe(false)
    expect(tracker.shouldStop()).toBe(false)
  })

  it('交错读取仍识别已经见过的结果', () => {
    const tracker = new InformationGainTracker()
    for (const key of ['a', 'b', 'a', 'c', 'a']) tracker.observe(key, 'body')
    expect(tracker.consecutiveNoGain).toBe(1)
    expect(tracker.redundantRepeats).toBe(2)
    expect(tracker.needsNudge()).toBe(true)
  })

  it('新结果之后回读旧结果仍累计重复', () => {
    const tracker = new InformationGainTracker()
    tracker.observe('read:a', 'A')
    tracker.observe('read:a', 'A')
    tracker.observe('read:a', 'B')
    tracker.observe('read:a', 'A')
    expect(tracker.consecutiveNoGain).toBe(1)
    expect(tracker.redundantRepeats).toBe(2)
  })

  it('结果变化清连续计数，但保留累计重复', () => {
    const tracker = new InformationGainTracker()
    tracker.observe('read:a', 'one')
    tracker.observe('read:a', 'one')
    tracker.observe('read:a', 'two')
    expect(tracker.consecutiveNoGain).toBe(0)
    expect(tracker.redundantRepeats).toBe(1)
    tracker.observe('read:a', 'one')
    expect(tracker.redundantRepeats).toBe(2)
  })

  it('写前收到提醒后仍读取新内容不停止，只有重复结果停止', () => {
    const continued = new InformationGainTracker()
    continued.observe('read:a', 'same')
    continued.observe('read:a', 'same')
    continued.observe('read:a', 'same')
    expect(continued.takeNudge()).toBe(true)
    continued.settleRound([
      { key: 'read:b', signature: 'fresh', repeat: continued.note('read:b', 'fresh') }
    ])
    continued.settleRound([
      { key: 'read:c', signature: 'also-fresh', repeat: continued.note('read:c', 'also-fresh') }
    ])
    expect(continued.shouldStop()).toBe(false)
    expect(continued.hasCandidateWritten()).toBe(false)

    const stopped = new InformationGainTracker()
    stopped.observe('read:a', 'same')
    stopped.observe('read:a', 'same')
    for (let index = 0; index < 5; index += 1) {
      stopped.settleRound([
        { key: 'read:a', signature: 'same', repeat: stopped.note('read:a', 'same') }
      ])
    }
    expect(stopped.shouldStop()).toBe(true)
    expect(stopped.redundantRepeats).toBe(6)
  })

  it('写成功清空探索，写失败保留预写无进展', () => {
    const tracker = new InformationGainTracker()
    tracker.observe('read:a', 'same')
    tracker.observe('read:a', 'same')
    tracker.observe('read:a', 'same')
    expect(tracker.takeNudge()).toBe(true)
    tracker.settleRound([
      { key: 'write:failed', signature: 'error', repeat: tracker.note('write:failed', 'error') }
    ])
    expect(tracker.redundantRepeats).toBe(2)
    expect(tracker.shouldStop()).toBe(false)
    expect(tracker.hasCandidateWritten()).toBe(false)
    tracker.onWriteSucceeded('game/scene/start.txt', 'path\nnext', true)
    expect(tracker.consecutiveNoGain).toBe(0)
    expect(tracker.redundantRepeats).toBe(0)
    expect(tracker.shouldStop()).toBe(false)
    expect(tracker.hasCandidateWritten()).toBe(true)
    tracker.settleRound([
      { key: 'read:a', signature: 'same', repeat: tracker.note('read:a', 'same') }
    ])
    tracker.afterModelResponse(false)
    tracker.settleRound([
      { key: 'read:b', signature: 'fresh', repeat: tracker.note('read:b', 'fresh') }
    ])
    tracker.afterModelResponse(false)
    expect(tracker.shouldStop()).toBe(false)
    expect(tracker.hasCandidateWritten()).toBe(true)
    expect(tracker.postWriteRounds()).toBe(2)
  })

  it('写出后 0 到 2 轮可以提交，第 3 轮无提交停止', () => {
    const direct = new InformationGainTracker()
    direct.onWriteSucceeded('game/scene/start.txt', 'one', true)
    direct.afterModelResponse(true)
    expect(direct.hasCandidateWritten()).toBe(false)
    expect(direct.shouldStopAfterPostWrite()).toBe(false)

    for (const rounds of [1, 2]) {
      const tracker = new InformationGainTracker()
      tracker.onWriteSucceeded('game/scene/start.txt', 'one', true)
      for (let index = 0; index < rounds; index += 1) tracker.afterModelResponse(false)
      expect(tracker.needsPostWriteNudge()).toBe(rounds === 2)
      expect(tracker.shouldStopAfterPostWrite()).toBe(false)
      tracker.afterModelResponse(true)
      expect(tracker.hasCandidateWritten()).toBe(false)
      expect(tracker.shouldStopAfterPostWrite()).toBe(false)
    }

    const stopped = new InformationGainTracker()
    stopped.onWriteSucceeded('game/scene/start.txt', 'one', true)
    stopped.afterModelResponse(false)
    stopped.afterModelResponse(false)
    expect(stopped.takePostWriteNudge()).toBe(true)
    expect(stopped.takePostWriteNudge()).toBe(false)
    stopped.afterModelResponse(false)
    expect(stopped.shouldStopAfterPostWrite()).toBe(true)
  })

  it('相同写入不重置阶段，不同写入只重置探索', () => {
    const tracker = new InformationGainTracker()
    tracker.observe('read:a', 'same')
    tracker.observe('read:a', 'same')
    tracker.observe('read:a', 'same')
    tracker.onWriteSucceeded('game/scene/start.txt', 'same-body', true)
    tracker.afterModelResponse(false)
    tracker.afterModelResponse(false)
    tracker.onWriteSucceeded('game/scene/start.txt', 'same-body', false)
    expect(tracker.hasCandidateWritten()).toBe(true)
    expect(tracker.postWriteRounds()).toBe(2)
    expect(tracker.needsPostWriteNudge()).toBe(true)
    tracker.onWriteSucceeded('game/scene/start.txt', 'changed-body', true)
    expect(tracker.postWriteRounds()).toBe(2)
    expect(tracker.consecutiveNoGain).toBe(0)
    expect(tracker.redundantRepeats).toBe(0)
    expect(tracker.shouldStopAfterPostWrite()).toBe(false)
  })

  it('提问式结构化提交结束写后阶段，新跟踪器从零开始', () => {
    const tracker = new InformationGainTracker()
    tracker.onWriteSucceeded('game/scene/start.txt', 'one', true)
    tracker.afterModelResponse(false)
    tracker.afterModelResponse(true)
    tracker.afterModelResponse(false)
    expect(tracker.postWriteRounds()).toBe(1)
    expect(tracker.shouldStopAfterPostWrite()).toBe(false)
    const nextInvoke = new InformationGainTracker()
    expect(nextInvoke.hasCandidateWritten()).toBe(false)
    expect(nextInvoke.postWriteRounds()).toBe(0)
  })

  it('原生通道无工具调用的终态响应视为提交，工具通道仍只认合法结构化调用', () => {
    const native = new ProviderStrategy({ type: 'object' })
    expect(
      hasStructuredSubmission({ content: '{"answer":"done"}', tool_calls: [] }, native)
    ).toBe(true)
    expect(
      hasStructuredSubmission(
        {
          content: '正在读取',
          tool_calls: [{ name: 'readTextRange', args: {}, id: 'call-1' }]
        },
        native
      )
    ).toBe(false)
    expect(
      hasStructuredSubmission(
        {
          content: '{"answer":"truncated"}',
          tool_calls: [],
          response_metadata: { finish_reason: 'length' }
        },
        native
      )
    ).toBe(false)

    const tool = ToolStrategy.fromSchema(
      z.object({ answer: z.string() }).meta({ title: 'submit_scene_result' })
    )
    expect(hasStructuredSubmission({ content: '没有提交', tool_calls: [] }, tool)).toBe(false)
    expect(
      hasStructuredSubmission(
        {
          content: '',
          tool_calls: [{ name: 'submit_scene_result', args: { answer: 'done' }, id: 'call-2' }]
        },
        tool
      )
    ).toBe(true)
  })

  it('原生通道写后终态响应结束写后阶段，带工具调用仍按阈值计数', () => {
    const native = new ProviderStrategy({ type: 'object' })
    const format = native

    const submitted = new InformationGainTracker()
    submitted.onWriteSucceeded('game/scene/start.txt', 'one', true)
    for (let index = 0; index < 3; index += 1) {
      submitted.afterModelResponse(
        hasStructuredSubmission({ content: '{"answer":"done"}', tool_calls: [] }, format)
      )
    }
    expect(submitted.postWriteRounds()).toBe(0)
    expect(submitted.shouldStopAfterPostWrite()).toBe(false)

    const pending = new InformationGainTracker()
    pending.onWriteSucceeded('game/scene/start.txt', 'one', true)
    for (let index = 0; index < 3; index += 1) {
      pending.afterModelResponse(
        hasStructuredSubmission(
          {
            content: '继续读取',
            tool_calls: [{ name: 'readTextRange', args: {}, id: `call-${index}` }]
          },
          format
        )
      )
    }
    expect(pending.shouldStopAfterPostWrite()).toBe(true)
  })

  it('结构化响应已结算时两种通道都算提交', () => {
    const native = new ProviderStrategy({ type: 'object' })
    expect(
      hasStructuredSubmission(
        { content: '{"answer":"done"}', structuredResponse: { answer: 'done' }, tool_calls: [] },
        native
      )
    ).toBe(true)
    expect(hasStructuredSubmission({ structuredResponse: { answer: 'done' } }, undefined)).toBe(
      true
    )
  })

  it('一百次不同调用不提示也不停止', () => {
    const tracker = new InformationGainTracker()
    for (let index = 0; index < 100; index += 1) {
      tracker.observe(`read:${index}`, `body-${index}`)
    }
    expect(tracker.redundantRepeats).toBe(0)
    expect(tracker.needsNudge()).toBe(false)
    expect(tracker.shouldStop()).toBe(false)
  })

  it('外置结果按版本比较，不按随机标识比较', () => {
    const first = externalized('id-1')
    const second = externalized('id-2')
    expect(signature(first)).toBe(signature(second))
    expect(signature(first)).not.toContain('id-1')
  })
})

function externalized(id: string): ToolMessage {
  return new ToolMessage({
    content: JSON.stringify({
      externalized: true,
      id,
      version: 'content-version',
      charLength: 12
    }),
    tool_call_id: 'call-1',
    name: 'read_file'
  })
}

function signature(message: ToolMessage): string {
  const value = JSON.parse(String(message.content)) as { version: string; charLength: number }
  return `${value.version}:${JSON.stringify(value.charLength)}`
}
