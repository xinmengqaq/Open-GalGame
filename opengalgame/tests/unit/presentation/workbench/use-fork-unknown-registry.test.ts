// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import {
  useForkUnknownRegistry,
  type ForkUnknownController,
  type ForkUnknownSource
} from '@presentation/pages/workbench/drawer/generation/useForkUnknownRegistry'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const sourceA: ForkUnknownSource = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  threadId: 'thread-1',
  branchId: 'branch-a',
  checkpointId: 'checkpoint-a'
}

const sourceB: ForkUnknownSource = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  threadId: 'thread-2',
  branchId: 'branch-b',
  checkpointId: 'checkpoint-b'
}

const sourceOtherScene: ForkUnknownSource = {
  projectId: 'project-1',
  sceneId: 'scene-2',
  threadId: 'thread-1',
  branchId: 'branch-c',
  checkpointId: 'checkpoint-c'
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>()
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve()
  })
}

type MountedRegistry = {
  readonly controller: () => ForkUnknownController
  updateScope: (scope: { projectId: string; sceneId: string }) => Promise<void>
  unmount: () => Promise<void>
}

const mounted: MountedRegistry[] = []

async function mountRegistry(scope: {
  projectId: string
  sceneId: string
}): Promise<MountedRegistry> {
  let current: ForkUnknownController | null = null
  let options = scope
  const Probe = (): null => {
    current = useForkUnknownRegistry(options)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  await flush()
  const host: MountedRegistry = {
    controller: () => {
      if (current === null) throw new Error('未知分叉登记尚未挂载')
      return current
    },
    updateScope: async (next) => {
      options = next
      await act(async () => {
        root.render(createElement(Probe))
      })
      await flush()
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
  mounted.push(host)
  return host
}

afterEach(async () => {
  while (mounted.length > 0) {
    const host = mounted.pop()
    await host?.unmount()
  }
})

describe('页面级未知分叉登记', () => {
  it('两个来源各自保留，只清对应项', async () => {
    const host = await mountRegistry({ projectId: 'project-1', sceneId: 'scene-1' })
    await act(async () => {
      host.controller().markUnknown(sourceA, '来源 A', '通信失败 A')
      host.controller().markUnknown(sourceB, '来源 B', '通信失败 B')
    })
    await flush()

    expect(host.controller().entries.map((entry) => entry.sourceSummary)).toEqual([
      '来源 A',
      '来源 B'
    ])

    await act(async () => {
      host.controller().acknowledge(sourceA)
    })
    await flush()
    expect(host.controller().entries.map((entry) => entry.sourceSummary)).toEqual(['来源 B'])

    await act(async () => {
      host.controller().acknowledge(sourceB)
    })
    await flush()
    expect(host.controller().entries).toHaveLength(0)
  })

  it('跨场景只显示当前场景的记录，切回后仍在', async () => {
    const host = await mountRegistry({ projectId: 'project-1', sceneId: 'scene-1' })
    await act(async () => {
      host.controller().markUnknown(sourceA, '来源 A', '通信失败 A')
      host.controller().markUnknown(sourceOtherScene, '其它场景', '通信失败 C')
    })
    await flush()

    expect(host.controller().entries.map((entry) => entry.sourceSummary)).toEqual(['来源 A'])

    await host.updateScope({ projectId: 'project-1', sceneId: 'scene-2' })
    expect(host.controller().entries.map((entry) => entry.sourceSummary)).toEqual(['其它场景'])

    await host.updateScope({ projectId: 'project-1', sceneId: 'scene-1' })
    expect(host.controller().entries.map((entry) => entry.sourceSummary)).toEqual(['来源 A'])
  })

  it('核对只在历史和发现都结束后完成；失败保留未知并可重试', async () => {
    const host = await mountRegistry({ projectId: 'project-1', sceneId: 'scene-1' })
    await act(async () => {
      host.controller().markUnknown(sourceA, '来源 A', '通信失败 A')
    })
    await flush()

    const history = deferred<{ ok: true } | { ok: false; message: string }>()
    const discovery = deferred<{ ok: true } | { ok: false; message: string }>()
    let check!: Promise<void>
    await act(async () => {
      check = host.controller().recheck(sourceA, {
        history: () => history.promise,
        discovery: () => discovery.promise
      })
    })
    expect(host.controller().entries[0]?.status).toBe('checking')

    await act(async () => {
      history.resolve({ ok: true })
    })
    await flush()
    expect(host.controller().entries[0]?.status).toBe('checking')

    await act(async () => {
      discovery.resolve({ ok: false, message: '场景已切换，发现没有刷新' })
      await check
    })
    expect(host.controller().entries[0]?.status).toBe('failed')
    expect(host.controller().entries[0]?.failureMessage).toBe('场景已切换，发现没有刷新')
    expect(host.controller().entries).toHaveLength(1)

    await act(async () => {
      await host.controller().recheck(sourceA, {
        history: async () => ({ ok: true }),
        discovery: async () => ({ ok: true })
      })
    })
    expect(host.controller().entries[0]?.status).toBe('rechecked')
    expect(host.controller().entries[0]?.failureMessage).toBeNull()
  })

  it('迟到核对结果不覆盖新一次核对，也不复活已确认的未知', async () => {
    const host = await mountRegistry({ projectId: 'project-1', sceneId: 'scene-1' })
    await act(async () => {
      host.controller().markUnknown(sourceA, '来源 A', '通信失败 A')
    })
    await flush()

    const firstHistory = deferred<{ ok: true }>()
    const firstDiscovery = deferred<{ ok: true }>()
    const secondHistory = deferred<{ ok: true }>()
    const secondDiscovery = deferred<{ ok: true }>()
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = host.controller().recheck(sourceA, {
        history: () => firstHistory.promise,
        discovery: () => firstDiscovery.promise
      })
      second = host.controller().recheck(sourceA, {
        history: () => secondHistory.promise,
        discovery: () => secondDiscovery.promise
      })
    })
    expect(host.controller().entries[0]?.status).toBe('checking')

    await act(async () => {
      firstHistory.resolve({ ok: true })
      firstDiscovery.resolve({ ok: true })
      await first
    })
    await flush()
    expect(host.controller().entries[0]?.status).toBe('checking')

    await act(async () => {
      secondHistory.resolve({ ok: false, message: '读取失败' })
      secondDiscovery.resolve({ ok: true })
      await second
    })
    expect(host.controller().entries[0]?.status).toBe('failed')
    expect(host.controller().entries[0]?.failureMessage).toBe('读取失败')

    const lateHistory = deferred<{ ok: true }>()
    const lateDiscovery = deferred<{ ok: true }>()
    let late!: Promise<void>
    await act(async () => {
      late = host.controller().recheck(sourceA, {
        history: () => lateHistory.promise,
        discovery: () => lateDiscovery.promise
      })
      host.controller().acknowledge(sourceA)
    })
    await flush()
    expect(host.controller().entries).toHaveLength(0)

    await act(async () => {
      lateHistory.resolve({ ok: true })
      lateDiscovery.resolve({ ok: true })
      await late
    })
    expect(host.controller().entries).toHaveLength(0)
  })

  it('并发核对按来源分别结算，迟到结果不贴到另一来源', async () => {
    const host = await mountRegistry({ projectId: 'project-1', sceneId: 'scene-1' })
    await act(async () => {
      host.controller().markUnknown(sourceA, '来源 A', '通信失败 A')
      host.controller().markUnknown(sourceB, '来源 B', '通信失败 B')
    })
    await flush()

    const aHistory = deferred<{ ok: true }>()
    const aDiscovery = deferred<{ ok: true }>()
    const bHistory = deferred<{ ok: true }>()
    const bDiscovery = deferred<{ ok: true }>()
    let aCheck!: Promise<void>
    let bCheck!: Promise<void>
    await act(async () => {
      aCheck = host.controller().recheck(sourceA, {
        history: () => aHistory.promise,
        discovery: () => aDiscovery.promise
      })
      bCheck = host.controller().recheck(sourceB, {
        history: () => bHistory.promise,
        discovery: () => bDiscovery.promise
      })
    })
    expect(host.controller().entries.every((entry) => entry.status === 'checking')).toBe(true)

    await act(async () => {
      aHistory.resolve({ ok: true })
      aDiscovery.resolve({ ok: true })
      await aCheck
    })
    await flush()
    const afterA = host.controller().entries
    expect(afterA.find((entry) => entry.sourceSummary === '来源 A')?.status).toBe(
      'rechecked'
    )
    expect(afterA.find((entry) => entry.sourceSummary === '来源 B')?.status).toBe(
      'checking'
    )

    await act(async () => {
      bHistory.resolve({ ok: false, message: 'B 读取失败' })
      bDiscovery.resolve({ ok: true })
      await bCheck
    })
    const afterB = host.controller().entries
    expect(afterB.find((entry) => entry.sourceSummary === '来源 A')?.status).toBe(
      'rechecked'
    )
    expect(afterB.find((entry) => entry.sourceSummary === '来源 B')?.status).toBe('failed')
    expect(afterB.find((entry) => entry.sourceSummary === '来源 B')?.failureMessage).toBe(
      'B 读取失败'
    )
  })
})
