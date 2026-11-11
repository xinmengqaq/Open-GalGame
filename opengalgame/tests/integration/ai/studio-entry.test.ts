import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toJsonSchema } from '@langchain/core/utils/json_schema'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Studio 开发入口', () => {
  it('模块导入不访问模型，默认不上传 Trace，调试图复用工厂完成两次模型和一次工具', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止付费请求'))
    vi.stubEnv('LANGSMITH_TRACING', undefined)
    const { graph, createStudioDebugGraph } =
      await import('../../../scripts/langsmith-studio/dev-entry')
    expect(fetcher).not.toHaveBeenCalled()
    expect(process.env.LANGSMITH_TRACING).toBe('false')
    const events: Array<{ type: string; status?: string }> = []
    const debug = createStudioDebugGraph({
      onEvent: (event) => {
        events.push(event)
      },
      console: false
    })
    const output = await debug.invoke({ prompt: '调试' })
    expect(output.result).toBe('本地调试完成')
    expect(
      events.filter((event) => event.type === 'model' && event.status === 'succeeded')
    ).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'tool' && event.status === 'succeeded')
    ).toHaveLength(1)
    expect(JSON.stringify(output)).not.toMatch(/budget|workspace|signal|credential/)
    expect(graph.getGraph().nodes).toHaveProperty('agent')
    expect(
      toJsonSchema(graph.builder._schemaRuntimeDefinition as Parameters<typeof toJsonSchema>[0])
    ).toMatchObject({ properties: { prompt: { type: 'string' }, result: { type: 'string' } } })
  }, 15000)

  it('取消仍经过执行保护；开发图配置和资源排除出发行包', async () => {
    const { createStudioDebugGraph } = await import('../../../scripts/langsmith-studio/dev-entry')
    const debug = createStudioDebugGraph({ console: false })
    const controller = new AbortController()
    controller.abort()
    await expect(debug.invoke({ prompt: '取消' }, { signal: controller.signal })).rejects.toThrow()
    const duringRun = new AbortController()
    const events: Array<{ type: string; status?: string }> = []
    const cancellable = createStudioDebugGraph({
      console: false,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'model' && event.status === 'started') duringRun.abort()
      }
    })
    await expect(
      cancellable.invoke({ prompt: '运行中取消' }, { signal: duringRun.signal })
    ).rejects.toThrow()
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'run' && event.status === 'cancelled')).toBe(
        true
      )
    )
    const packaging = await readFile('electron-builder.yml', 'utf8')
    const patterns = [...packaging.matchAll(/^\s+- '(![^']+)'/gm)].map((match) => match[1])
    const filter = new FileMatcher(resolve('.'), resolve('dist'), (value) => value, [
      '**/*',
      ...patterns
    ]).createFilter()
    const fileStat = await stat('langgraph.json')
    for (const file of [
      'langgraph.json',
      'scripts/langsmith-studio/dev-entry.ts',
      'scripts/langsmith-studio/prompts/studio-debug/system.md',
      'scripts/langsmith-studio/node_modules/typescript/package.json',
      '.langgraph_api/threads.json'
    ]) {
      expect(filter(resolve(file), fileStat), file).toBe(false)
    }
    expect(filter(resolve('package.json'), fileStat)).toBe(true)
    const config = JSON.parse(await readFile('langgraph.json', 'utf8'))
    expect(config.graphs.debug).toBe('./scripts/langsmith-studio/dev-entry.ts:graph')
  })
})
