import type {
  GuideFact,
  GuideFactOutcome
} from '@presentation/features/beginner-guide/guideObservation'

export const TEST_SCOPE = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  canvasId: 'canvas-1'
}

let nextFactSequence = 0

function takeSequence(): number {
  nextFactSequence += 1
  return nextFactSequence
}

type FactInput<T extends GuideFact> = Omit<T, 'outcome' | 'sequence' | 'occurredAt' | 'scope'> & {
  scope?: T['scope']
  outcome?: GuideFactOutcome
  sequence?: number
  occurredAt?: string
}

/** 测试用事实工厂：默认 confirmed、同一工程/场景、单调递增序号。 */
export function fact<T extends GuideFact>(input: FactInput<T>): T {
  const {
    scope = TEST_SCOPE,
    outcome = 'confirmed',
    sequence = takeSequence(),
    occurredAt = '2026-11-22T10:00:00.000Z',
    ...rest
  } = input

  return {
    ...rest,
    scope,
    outcome,
    sequence,
    occurredAt
  } as T
}
