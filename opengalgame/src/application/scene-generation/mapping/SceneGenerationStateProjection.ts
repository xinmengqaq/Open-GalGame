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

export function isTerminalState(state: SceneGenerationStateVO): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

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

export function renderStageOf(
  state: SceneGenerationStateVO,
  step?: SceneGenerationStepVO,
  interruptReason?: SceneGenerationInterruptReason
): SceneGenerationRenderStage {
  if (state === 'interrupted') {
    if (interruptReason === 'readInterrupted') return 'validating'
    return interruptReason === undefined || interruptReason === 'paused' ? 'paused' : 'failed'
  }
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
