import type {
  SceneGenerationPhaseVO,
  SceneGenerationStateVO,
  SceneGenerationStepVO
} from '../vo/SceneGenerationVO'
import type { SceneGenerationRenderStage } from '../vo/SceneGenerationRenderVO'
import type { SceneGenerationInterruptReason } from '../models/SceneGenerationExecution'

const PHASE_BY_STEP: Record<SceneGenerationStepVO, SceneGenerationPhaseVO> = {
  preparing: 'preparing',
  generating: 'generating',
  reading: 'reading',
  validating: 'validating',
  correcting: 'correcting',
  converting: 'converting',
  committing: 'committing',
  rollingBack: 'rollingBack'
}

const STEP_MESSAGE: Record<SceneGenerationStepVO, string> = {
  preparing: '准备输入',
  generating: '生成场景',
  reading: '读取产物',
  validating: '校验产物',
  correcting: '修正场景',
  converting: '转换预览',
  committing: '提交作品',
  rollingBack: '回退'
}

/** 终态判断只看 state，任何 phase/step 都不能参与终态判定。 */
export function isTerminalState(state: SceneGenerationStateVO): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

/**
 * 从唯一权威 state 与可选业务 step 派生外部阶段。
 * 全函数：任意 state + step 组合都有确定结果；终态优先于 step。
 */
export function phaseOf(
  state: SceneGenerationStateVO,
  step?: SceneGenerationStepVO
): SceneGenerationPhaseVO {
  switch (state) {
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'waiting':
      return 'waiting'
    case 'interrupted':
      return step ? PHASE_BY_STEP[step] : 'waiting'
    case 'committing':
      return step ? PHASE_BY_STEP[step] : 'committing'
    case 'cancelling':
      return step ? PHASE_BY_STEP[step] : 'preparing'
    case 'pending':
    case 'running':
      return step ? PHASE_BY_STEP[step] : 'preparing'
  }
}

/**
 * 从 state + step 派生渲染阶段。中断原因只影响展示层，
 * 不单独构成业务状态；全函数保证任意组合都有渲染阶段。
 */
export function renderStageOf(
  state: SceneGenerationStateVO,
  step?: SceneGenerationStepVO,
  interruptReason?: SceneGenerationInterruptReason
): SceneGenerationRenderStage {
  if (state === 'interrupted')
    return interruptReason === undefined || interruptReason === 'paused' ? 'paused' : 'failed'
  if (state === 'succeeded') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'cancelled'
  if (state === 'waiting') return 'waitingReview'
  if (state === 'committing' || step === 'committing') return 'committing'
  if (
    step === 'reading' ||
    step === 'validating' ||
    step === 'correcting' ||
    step === 'converting'
  )
    return 'validating'
  if (step === 'generating') return 'generating'
  return 'readingInput'
}

/** 进度事件的展示文案；终态文案由 state 决定，中间态由 step 决定。 */
export function progressMessageOf(
  state: SceneGenerationStateVO,
  step?: SceneGenerationStepVO
): string {
  if (state === 'succeeded') return '完成'
  if (state === 'failed') return '失败'
  if (state === 'cancelled') return '取消'
  if (state === 'waiting') return '等待人工'
  if (step) return STEP_MESSAGE[step]
  if (state === 'interrupted') return '已中断，等待恢复'
  return STEP_MESSAGE.preparing
}
