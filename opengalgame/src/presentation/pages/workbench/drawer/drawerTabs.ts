export type DrawerTabId = 'current' | 'summary' | 'history' | 'candidate' | 'works'

export const DRAWER_TAB_ORDER: readonly DrawerTabId[] = [
  'current',
  'summary',
  'history',
  'candidate',
  'works'
]

export const DRAWER_TAB_LABEL: Readonly<Record<DrawerTabId, string>> = {
  current: '当前生成',
  summary: '输入摘要',
  history: 'AI 历史',
  candidate: '游戏候选',
  works: '作品历史'
}

export interface DrawerTabBadge {
  count: number
  live: boolean
}

export type DrawerTabTone =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'failed'
  | 'pendingVerification'

export const DRAWER_TAB_TONE_LABEL: Readonly<Record<DrawerTabTone, string>> = {
  running: '进行中',
  waiting: '等待你回复',
  paused: '已暂停',
  failed: '生成失败',
  pendingVerification: '结果待核对'
}

export interface DrawerTabsState {
  open: DrawerTabId[]
  active: DrawerTabId
  candidateAvailable: boolean | null
  candidateId: string | null
  closedCandidateId: string | null
}

export type DrawerTabsAction =
  | { type: 'open'; tab: DrawerTabId }
  | { type: 'activate'; tab: DrawerTabId }
  | { type: 'close'; tab: DrawerTabId; worksBusy?: boolean }
  | { type: 'move'; tab: DrawerTabId; toIndex: number }
  | {
      type: 'candidate-availability'
      available: boolean
      candidateSnapshotId: string | null
    }
  | { type: 'reset' }

export function createDrawerTabsState(): DrawerTabsState {
  return {
    open: ['current'],
    active: 'current',
    candidateAvailable: null,
    candidateId: null,
    closedCandidateId: null
  }
}

export function isDrawerTabClosable(tab: DrawerTabId, worksBusy = false): boolean {
  if (tab === 'current') return false
  return !(tab === 'works' && worksBusy)
}

export function drawerTabDomId(tab: DrawerTabId): string {
  return `wb-drawer-tab-${tab}`
}

export function drawerTabViewId(tab: DrawerTabId): string {
  return `wb-drawer-view-${tab}`
}

export function availableDrawerTabs(
  open: readonly DrawerTabId[],
  options: { candidateAvailable: boolean }
): DrawerTabId[] {
  return DRAWER_TAB_ORDER.filter(
    (tab) =>
      tab !== 'current' &&
      !open.includes(tab) &&
      (tab !== 'candidate' || options.candidateAvailable)
  )
}

export function drawerReorderIndex(
  tabs: readonly DrawerTabId[],
  moving: DrawerTabId,
  over: DrawerTabId,
  edge: 'before' | 'after'
): number | null {
  const from = tabs.indexOf(moving)
  const overIndex = tabs.indexOf(over)
  if (from < 0 || overIndex < 0 || moving === 'current' || moving === over) return null
  let target = edge === 'after' ? overIndex + 1 : overIndex
  if (from < target) target -= 1
  return Math.min(Math.max(target, 1), tabs.length - 1)
}

function dropDrawerTab(
  state: DrawerTabsState,
  tab: DrawerTabId,
  rememberClosedCandidate: boolean
): DrawerTabsState {
  const index = state.open.indexOf(tab)
  if (index < 0) return state
  const open = state.open.filter((id) => id !== tab)
  const fallback = index > 0 ? open[index - 1] : undefined
  const active = state.active === tab ? (fallback ?? 'current') : state.active
  return {
    ...state,
    open,
    active,
    candidateId: tab === 'candidate' ? null : state.candidateId,
    closedCandidateId:
      tab === 'candidate' && rememberClosedCandidate
        ? (state.candidateId ?? state.closedCandidateId)
        : state.closedCandidateId
  }
}

function moveDrawerTab(state: DrawerTabsState, tab: DrawerTabId, toIndex: number): DrawerTabsState {
  if (tab === 'current') return state
  const from = state.open.indexOf(tab)
  if (from < 0) return state
  if (!Number.isFinite(toIndex)) return state
  const target = Math.min(Math.max(Math.trunc(toIndex), 1), state.open.length - 1)
  if (target === from) return state
  const open = state.open.filter((id) => id !== tab)
  open.splice(target, 0, tab)
  return { ...state, open }
}

function applyCandidateAvailability(
  state: DrawerTabsState,
  available: boolean,
  candidateSnapshotId: string | null
): DrawerTabsState {
  if (!available) {
    if (
      state.candidateAvailable === false &&
      state.candidateId === null &&
      !state.open.includes('candidate')
    ) {
      return state
    }
    const next: DrawerTabsState = {
      ...state,
      candidateAvailable: false,
      candidateId: null
    }
    return state.open.includes('candidate') ? dropDrawerTab(next, 'candidate', false) : next
  }

  if (candidateSnapshotId !== null && candidateSnapshotId === state.closedCandidateId) {
    if (state.candidateAvailable === true && state.candidateId === null) return state
    return { ...state, candidateAvailable: true, candidateId: null }
  }

  if (state.candidateAvailable === null) {
    return { ...state, candidateAvailable: true, candidateId: candidateSnapshotId }
  }

  const shouldJoin =
    state.candidateAvailable === false ||
    (candidateSnapshotId !== null && candidateSnapshotId !== state.candidateId)
  if (!shouldJoin) {
    return state.candidateId === candidateSnapshotId
      ? state
      : { ...state, candidateId: candidateSnapshotId }
  }

  const next: DrawerTabsState = {
    ...state,
    candidateAvailable: true,
    candidateId: candidateSnapshotId,
    closedCandidateId: candidateSnapshotId === null ? state.closedCandidateId : null
  }
  if (next.open.includes('candidate')) return next
  return { ...next, open: [...next.open, 'candidate'] }
}

export function drawerTabsReducer(
  state: DrawerTabsState,
  action: DrawerTabsAction
): DrawerTabsState {
  switch (action.type) {
    case 'reset':
      return createDrawerTabsState()
    case 'open': {
      if (state.open.includes(action.tab)) {
        return state.active === action.tab ? state : { ...state, active: action.tab }
      }
      return { ...state, open: [...state.open, action.tab], active: action.tab }
    }
    case 'activate': {
      if (!state.open.includes(action.tab)) return state
      return state.active === action.tab ? state : { ...state, active: action.tab }
    }
    case 'close': {
      if (!isDrawerTabClosable(action.tab, action.worksBusy === true)) return state
      return dropDrawerTab(state, action.tab, true)
    }
    case 'move':
      return moveDrawerTab(state, action.tab, action.toIndex)
    case 'candidate-availability':
      return applyCandidateAvailability(state, action.available, action.candidateSnapshotId)
  }
}
