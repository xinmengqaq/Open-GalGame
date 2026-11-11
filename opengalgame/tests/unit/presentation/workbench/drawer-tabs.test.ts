import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  availableDrawerTabs,
  createDrawerTabsState,
  drawerReorderIndex,
  drawerTabsReducer,
  isDrawerTabClosable,
  type DrawerTabId,
  type DrawerTabsState
} from '@presentation/pages/workbench/drawer/drawerTabs'
import {
  useDrawerTabs,
  drawerTabsSnapshotForScope
} from '@presentation/pages/workbench/drawer/useDrawerTabs'

function opened(...tabs: DrawerTabId[]): DrawerTabsState {
  return tabs.reduce<DrawerTabsState>(
    (state, tab) => drawerTabsReducer(state, { type: 'open', tab }),
    createDrawerTabsState()
  )
}

function activated(...tabs: DrawerTabId[]): DrawerTabsState {
  const state = opened(...tabs)
  const last = tabs[tabs.length - 1]
  return last ? drawerTabsReducer(state, { type: 'activate', tab: last }) : state
}

describe('drawerTabsReducer 打开与激活', () => {
  it('默认只打开当前生成，当前生成不可关闭', () => {
    const state = createDrawerTabsState()
    expect(state.open).toEqual(['current'])
    expect(state.active).toBe('current')
    expect(isDrawerTabClosable('current')).toBe(false)
    expect(drawerTabsReducer(state, { type: 'close', tab: 'current' })).toBe(state)
  })

  it('打开新视图会激活；重复打开只聚焦，不重复创建', () => {
    const withSummary = opened('summary')
    expect(withSummary.open).toEqual(['current', 'summary'])
    expect(withSummary.active).toBe('summary')

    const focused = drawerTabsReducer(withSummary, { type: 'open', tab: 'summary' })
    expect(focused.open).toEqual(['current', 'summary'])

    const backToCurrent = drawerTabsReducer(focused, { type: 'open', tab: 'current' })
    expect(backToCurrent.active).toBe('current')
    expect(backToCurrent.open).toEqual(['current', 'summary'])
  })

  it('激活未打开的视图不改变状态', () => {
    const state = opened('summary')
    expect(drawerTabsReducer(state, { type: 'activate', tab: 'history' })).toBe(state)
  })
})

describe('drawerTabsReducer 关闭', () => {
  it('关闭活动标签后激活左侧最近标签，没有可选标签时回到当前生成', () => {
    const state = activated('summary', 'history', 'works')

    const closedWorks = drawerTabsReducer(state, { type: 'close', tab: 'works' })
    expect(closedWorks.open).toEqual(['current', 'summary', 'history'])
    expect(closedWorks.active).toBe('history')

    const closedHistory = drawerTabsReducer(closedWorks, { type: 'close', tab: 'history' })
    expect(closedHistory.active).toBe('summary')

    const closedSummary = drawerTabsReducer(closedHistory, { type: 'close', tab: 'summary' })
    expect(closedSummary.open).toEqual(['current'])
    expect(closedSummary.active).toBe('current')
  })

  it('关闭非活动标签不切换当前标签', () => {
    const state = activated('summary', 'history')
    expect(state.active).toBe('history')

    const closed = drawerTabsReducer(state, { type: 'close', tab: 'summary' })
    expect(closed.active).toBe('history')
    expect(closed.open).toEqual(['current', 'history'])
  })

  it('作品历史写操作在途时拒绝关闭', () => {
    const state = activated('works')

    expect(drawerTabsReducer(state, { type: 'close', tab: 'works', worksBusy: true })).toBe(state)
    expect(isDrawerTabClosable('works', true)).toBe(false)
    expect(isDrawerTabClosable('works', false)).toBe(true)

    const closed = drawerTabsReducer(state, { type: 'close', tab: 'works', worksBusy: false })
    expect(closed.open).toEqual(['current'])
    expect(closed.active).toBe('current')
  })
})

describe('drawerTabsReducer 候选自动加入', () => {
  function candidateReport(
    state: DrawerTabsState,
    available: boolean,
    candidateSnapshotId: string | null
  ): DrawerTabsState {
    return drawerTabsReducer(state, {
      type: 'candidate-availability',
      available,
      candidateSnapshotId
    })
  }

  it('候选可用性 false→true 加入标签但不切换', () => {
    const unavailable = candidateReport(opened('summary'), false, null)
    expect(unavailable.active).toBe('summary')

    const joined = candidateReport(unavailable, true, 'candidate-1')
    expect(joined.open).toEqual(['current', 'summary', 'candidate'])
    expect(joined.active).toBe('summary')
    expect(joined.candidateId).toBe('candidate-1')

    const repeated = candidateReport(joined, true, 'candidate-1')
    expect(repeated.open).toEqual(['current', 'summary', 'candidate'])
  })

  it('新范围的第一份报告只建基线，已有候选不补标签', () => {
    const baselined = candidateReport(createDrawerTabsState(), true, 'candidate-1')
    expect(baselined.open).toEqual(['current'])
    expect(baselined.active).toBe('current')
    expect(baselined.candidateAvailable).toBe(true)
    expect(baselined.candidateId).toBe('candidate-1')

    /* 同一候选的后续报告仍不是 false→true，不补标签。 */
    expect(candidateReport(baselined, true, 'candidate-1').open).toEqual(['current'])
  })

  it('用户关闭同一候选后不再自动加入，新候选清除记忆', () => {
    const joined = candidateReport(
      candidateReport(opened('summary'), false, null),
      true,
      'candidate-1'
    )

    const closed = drawerTabsReducer(joined, { type: 'close', tab: 'candidate' })
    expect(closed.open).toEqual(['current', 'summary'])
    expect(closed.closedCandidateId).toBe('candidate-1')
    expect(closed.candidateId).toBeNull()

    const sameAgain = candidateReport(closed, true, 'candidate-1')
    expect(sameAgain.open).toEqual(['current', 'summary'])

    const nextCandidate = candidateReport(sameAgain, true, 'candidate-2')
    expect(nextCandidate.open).toEqual(['current', 'summary', 'candidate'])
    expect(nextCandidate.candidateId).toBe('candidate-2')
    expect(nextCandidate.closedCandidateId).toBeNull()
  })

  it('候选不可用时移除标签并回到左侧标签，不改变关闭记忆', () => {
    const joined = candidateReport(
      candidateReport(activated('summary'), false, null),
      true,
      'candidate-1'
    )
    const withCandidateActive = drawerTabsReducer(joined, {
      type: 'activate',
      tab: 'candidate'
    })

    const gone = candidateReport(withCandidateActive, false, null)
    expect(gone.open).toEqual(['current', 'summary'])
    expect(gone.active).toBe('summary')
    expect(gone.candidateId).toBeNull()
    expect(gone.closedCandidateId).toBeNull()

    /* 再次可用仍按 false→true 加入，用户没有关闭过它。 */
    expect(candidateReport(gone, true, 'candidate-1').open).toEqual([
      'current',
      'summary',
      'candidate'
    ])
  })

  it('切换范围重置后不为已有候选补标签', () => {
    const joined = candidateReport(
      candidateReport(createDrawerTabsState(), false, null),
      true,
      'candidate-1'
    )
    const closed = drawerTabsReducer(joined, { type: 'close', tab: 'candidate' })

    const reset = drawerTabsReducer(closed, { type: 'reset' })
    expect(reset.open).toEqual(['current'])
    expect(reset.closedCandidateId).toBeNull()

    const reportInNewScope = candidateReport(reset, true, 'candidate-1')
    expect(reportInNewScope.open).toEqual(['current'])
    expect(reportInNewScope.candidateId).toBe('candidate-1')
  })
})

describe('drawerTabsReducer 重排', () => {
  it('其他标签可以移动，当前生成固定第一', () => {
    const state = opened('summary', 'history', 'works')
    expect(state.open).toEqual(['current', 'summary', 'history', 'works'])

    const moved = drawerTabsReducer(state, { type: 'move', tab: 'history', toIndex: 1 })
    expect(moved.open).toEqual(['current', 'history', 'summary', 'works'])

    expect(drawerTabsReducer(moved, { type: 'move', tab: 'current', toIndex: 3 })).toBe(moved)
  })

  it('目标下标越界时收敛到可移动范围', () => {
    const state = opened('summary', 'history', 'works')
    expect(drawerTabsReducer(state, { type: 'move', tab: 'summary', toIndex: 99 }).open).toEqual([
      'current',
      'history',
      'works',
      'summary'
    ])
    expect(drawerTabsReducer(state, { type: 'move', tab: 'works', toIndex: 0 }).open).toEqual([
      'current',
      'works',
      'summary',
      'history'
    ])
    expect(drawerTabsReducer(state, { type: 'move', tab: 'works', toIndex: Number.NaN })).toBe(
      state
    )
  })

  it('拖拽目标下标不越过当前生成，也不把标签放到原地', () => {
    const tabs: DrawerTabId[] = ['current', 'summary', 'history', 'works']
    expect(drawerReorderIndex(tabs, 'summary', 'works', 'before')).toBe(2)
    expect(drawerReorderIndex(tabs, 'summary', 'works', 'after')).toBe(3)
    expect(drawerReorderIndex(tabs, 'works', 'summary', 'before')).toBe(1)
    expect(drawerReorderIndex(tabs, 'history', 'summary', 'after')).toBe(2)
    expect(drawerReorderIndex(tabs, 'current', 'works', 'after')).toBeNull()
    expect(drawerReorderIndex(tabs, 'summary', 'summary', 'after')).toBeNull()
  })
})

describe('useDrawerTabs', () => {
  it('首次渲染只打开当前生成，并给出完整控制器', () => {
    function Probe(): ReactElement {
      const tabs = useDrawerTabs('project-1|scene-1')
      return createElement('span', {
        'data-active': tabs.state.active,
        'data-actions': [
          typeof tabs.open,
          typeof tabs.activate,
          typeof tabs.close,
          typeof tabs.move,
          typeof tabs.syncCandidate,
          typeof tabs.reset
        ].join(','),
        'data-open': tabs.state.open.join(',')
      })
    }

    const html = renderToStaticMarkup(createElement(Probe))
    expect(html).toContain('data-active="current"')
    expect(html).toContain('data-open="current"')
    expect(html).toContain('data-actions="function,function,function,function,function,function"')
  })
})

describe('drawerTabs 范围与菜单入口', () => {
  it('同一工程/场景保留标签，切换范围重置为只开当前生成', () => {
    const snapshot = {
      scope: 'project-1|scene-1',
      tabs: opened('summary', 'history', 'works')
    }

    expect(drawerTabsSnapshotForScope(snapshot, 'project-1|scene-1')).toBe(snapshot)

    const switched = drawerTabsSnapshotForScope(snapshot, 'project-1|scene-2')
    expect(switched.scope).toBe('project-1|scene-2')
    expect(switched.tabs.open).toEqual(['current'])
    expect(switched.tabs.active).toBe('current')
    expect(switched.tabs.candidateId).toBeNull()
    expect(switched.tabs.closedCandidateId).toBeNull()
  })

  it('+ 菜单只列未打开的视图，候选只在可用时出现', () => {
    expect(availableDrawerTabs(['current'], { candidateAvailable: false })).toEqual([
      'summary',
      'history',
      'works'
    ])
    expect(availableDrawerTabs(['current'], { candidateAvailable: true })).toEqual([
      'summary',
      'history',
      'candidate',
      'works'
    ])
    expect(
      availableDrawerTabs(['current', 'summary', 'candidate'], { candidateAvailable: true })
    ).toEqual(['history', 'works'])
  })
})
