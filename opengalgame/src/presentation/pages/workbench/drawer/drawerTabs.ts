/**
 * 生成抽屉的浏览器式标签模型。
 *
 * 只维护标签的开关、激活、顺序和候选标签的自动加入，不持有生成、候选或历史数据。
 * 视图内容、写操作忙碌状态和候选可用性都由调用方按真实事实传入。
 */

/** 抽屉标签的固定身份。 */
export type DrawerTabId = 'current' | 'summary' | 'history' | 'candidate' | 'works'

/** `+` 菜单的固定展示顺序；实际标签顺序由已打开标签决定。 */
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

/** 候选标签角标：只来自真实读取结果，未读取时用活动点。 */
export interface DrawerTabBadge {
  /** 真实读取问题数；未读取时为 0。 */
  count: number
  /** 正在读取或已打开但还没有读取结果。 */
  live: boolean
}

/** “当前生成”的状态点；null 表示还没有可显示的任务状态。 */
export type DrawerTabTone =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'failed'
  /** 提交结果不明，等待核对；不是失败。 */
  | 'pendingVerification'

export const DRAWER_TAB_TONE_LABEL: Readonly<Record<DrawerTabTone, string>> = {
  running: '进行中',
  waiting: '等待你回复',
  paused: '已暂停',
  failed: '生成失败',
  pendingVerification: '结果待核对'
}

export interface DrawerTabsState {
  /** 已打开标签，`current` 恒在首位。 */
  open: DrawerTabId[]
  active: DrawerTabId
  /** 上次报告的候选可用性；null 表示当前范围还没有基线。 */
  candidateAvailable: boolean | null
  /** 当前已知的候选身份，不表示标签一定打开。 */
  candidateId: string | null
  /** 用户关闭过的候选；同一候选不再自动加入，新候选出现时清除。 */
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

/** 新范围或重置后的唯一状态：只打开“当前生成”。 */
export function createDrawerTabsState(): DrawerTabsState {
  return {
    open: ['current'],
    active: 'current',
    candidateAvailable: null,
    candidateId: null,
    closedCandidateId: null
  }
}

/** “当前生成”固定第一且不可关闭；“作品历史”写操作在途时也不能关闭。 */
export function isDrawerTabClosable(tab: DrawerTabId, worksBusy = false): boolean {
  if (tab === 'current') return false
  return !(tab === 'works' && worksBusy)
}

/** 标签在同一个工程/场景内的稳定 DOM id，供面板 `aria-labelledby` 对应。 */
export function drawerTabDomId(tab: DrawerTabId): string {
  return `wb-drawer-tab-${tab}`
}

/** 标签对应视图的 DOM id，供 `aria-controls` 对应。 */
export function drawerTabViewId(tab: DrawerTabId): string {
  return `wb-drawer-view-${tab}`
}

/**
 * `+` 菜单只列未打开的视图；“游戏候选”只在有固定候选时出现。
 * 已打开的视图不重复列出，调用方改用激活动作聚焦。
 */
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

/**
 * 拖拽的目标位置（移动完成后的最终下标）。
 * 返回 null 表示这次拖拽不改变顺序；`current` 固定第一，目标下标从 1 开始。
 */
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

  /* 用户关闭过的同一候选不再自动加入；新候选出现时清除这条记忆。 */
  if (candidateSnapshotId !== null && candidateSnapshotId === state.closedCandidateId) {
    if (state.candidateAvailable === true && state.candidateId === null) return state
    return { ...state, candidateAvailable: true, candidateId: null }
  }

  /* 新范围的第一份报告只建立基线：已有候选不补标签。 */
  if (state.candidateAvailable === null) {
    return { ...state, candidateAvailable: true, candidateId: candidateSnapshotId }
  }

  /* 只有可用性 false→true，或换上了一个新候选，才自动加入标签。 */
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
