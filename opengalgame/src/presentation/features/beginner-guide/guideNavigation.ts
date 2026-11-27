import {
  GUIDE_ARRANGE_BEATS,
  GUIDE_STEP_ID,
  GUIDE_STEPS,
  guideArrangeBeatById,
  guideStepById,
  type GuideArrangeBeatId,
  type GuideStepId
} from './guideSteps'
import type { GuidePrompt, GuideSessionState } from './advanceGuide'

/** 导航目标：普通步骤只给 id，第 4 步再带编排拍。 */
export type GuideNavTarget = {
  stepId: GuideStepId
  beatId: GuideArrangeBeatId | null
}

/** 导航单元：普通步骤算一个，第 4 步按六拍拆开。 */
export type GuideNavUnit = GuideNavTarget & {
  stepNumber: number
  beatNumber: number | null
  /** 在全部导航单元里的顺序；只用于比较。 */
  order: number
  /** 可读名称，如「第 3 步「导入剧本」」或「第 4 步第 2 拍「先让玩家听见」」。 */
  label: string
}

export type GuideNavButtonView = {
  enabled: boolean
  /** 按钮上的动作名，始终是「上一步」或「下一步」。 */
  label: string
  /** 读屏名称，包含目的地或不可用原因。 */
  ariaLabel: string
}

export type GuideNavigationView = {
  previous: GuideNavButtonView
  next: GuideNavButtonView
}

const ALL_NAV_UNITS: readonly GuideNavUnit[] = buildAllNavUnits()

function buildAllNavUnits(): GuideNavUnit[] {
  const units: GuideNavUnit[] = []
  for (const step of GUIDE_STEPS) {
    if (step.id === GUIDE_STEP_ID.arrangeScene) {
      for (const beat of step.arrangeBeats ?? GUIDE_ARRANGE_BEATS) {
        units.push({
          stepId: step.id,
          beatId: beat.id,
          stepNumber: step.number,
          beatNumber: beat.number,
          order: units.length,
          label: `第 ${step.number} 步第 ${beat.number} 拍「${beat.title}」`
        })
      }
      continue
    }
    units.push({
      stepId: step.id,
      beatId: null,
      stepNumber: step.number,
      beatNumber: null,
      order: units.length,
      label: `第 ${step.number} 步「${step.title}」`
    })
  }
  return units
}

function arrangeBeatIdOfState(state: GuideSessionState): GuideArrangeBeatId | null {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return null
  const step = guideStepById(state.stepId)
  const milestone = step.milestones[state.milestoneIndex]
  if (milestone?.arrange) return milestone.arrange.beatId
  const beats = step.arrangeBeats ?? GUIDE_ARRANGE_BEATS
  if (beats.length === 0) return null
  return state.milestoneIndex >= step.milestones.length
    ? (beats[beats.length - 1]?.id ?? null)
    : (beats[0]?.id ?? null)
}

/** 当前跟做/查看位置对应的导航单元。 */
export function guideCurrentNavUnit(state: GuideSessionState): GuideNavUnit {
  const beatId = arrangeBeatIdOfState(state)
  const unit = ALL_NAV_UNITS.find((item) => item.stepId === state.stepId && item.beatId === beatId)
  if (unit) return unit
  const fallback = ALL_NAV_UNITS.find((item) => item.stepId === GUIDE_STEP_ID.configureModel)
  if (!fallback) throw new Error('新手指引没有可用的导航单元')
  return fallback
}

export function guideBeatIdOf(state: GuideSessionState): GuideArrangeBeatId | null {
  return arrangeBeatIdOfState(state)
}

export function guidePreviousNavUnit(state: GuideSessionState): GuideNavUnit | null {
  const current = guideCurrentNavUnit(state)
  return ALL_NAV_UNITS[current.order - 1] ?? null
}

export function guideNextNavUnit(state: GuideSessionState): GuideNavUnit | null {
  const current = guideCurrentNavUnit(state)
  return ALL_NAV_UNITS[current.order + 1] ?? null
}

/** 跳到某个单元时，该单元的第一个里程碑。 */
export function guideNavUnitMilestoneIndex(target: GuideNavTarget): number {
  if (!target.beatId) return 0
  const step = guideStepById(target.stepId)
  return step.milestones.findIndex((milestone) => milestone.arrange?.beatId === target.beatId)
}

/** 跳到某个单元时显示的起始动作；不读取画布绑定，也不标记完成。 */
export function guideNavUnitPrompt(state: GuideSessionState, target: GuideNavTarget): GuidePrompt {
  const step = guideStepById(target.stepId)
  if (!target.beatId) {
    return {
      stepId: step.id,
      stepNumber: step.number,
      milestoneId: step.milestones[0]?.id ?? null,
      title: step.actionTitle,
      text: step.action,
      tone: 'action',
      hidden: state.collapsed
    }
  }
  const beat = guideArrangeBeatById(target.beatId)
  const milestoneIndex = guideNavUnitMilestoneIndex(target)
  return {
    stepId: step.id,
    stepNumber: step.number,
    milestoneId: step.milestones[milestoneIndex]?.id ?? null,
    title: beat.number === 1 ? step.actionTitle : beat.title,
    text: beat.action,
    tone: 'action',
    hidden: state.collapsed
  }
}

/**
 * 上一步/下一步只决定位置，不判断完成状态。只要还有前/后一个单元就可用；
 * 未完成步骤也可以前进，跳转本身不写完成记录。
 */
export function guideNavigationViewOf(state: GuideSessionState): GuideNavigationView {
  const previous = guidePreviousNavUnit(state)
  const next = guideNextNavUnit(state)
  return {
    previous: previous
      ? {
          enabled: true,
          label: '上一步',
          ariaLabel: `上一步，回到${previous.label}`
        }
      : {
          enabled: false,
          label: '上一步',
          ariaLabel: '上一步，暂不可用：已经是第一步'
        },
    next: next
      ? {
          enabled: true,
          label: '下一步',
          ariaLabel: `下一步，前往${next.label}`
        }
      : {
          enabled: false,
          label: '下一步',
          ariaLabel: '下一步，暂不可用：已经是最后一步'
        }
  }
}
