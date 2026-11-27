import type {
  CatalogImportOptions,
  CatalogImportOutcome
} from '../input-catalog/inputCatalog.types'
import type { GuideAssetCardKind } from './guideObservation'

export type GuideMediaImportOutcome =
  | 'imported'
  | 'wrong-kind'
  | 'cancelled'
  | 'failed'
  | 'unverified'
  | 'unavailable'

export type GuideMediaImportAction = (
  kind: GuideAssetCardKind
) => Promise<GuideMediaImportOutcome>

/**
 * 导入按钮临时结果的失效键：工程、场景、画布、本步骤进入代次和当前拍。
 * 任何一项变化后，旧选择/旧 Promise 都不能写进新界面。
 */
export function guideImportAttemptKey(input: {
  projectId: string | null
  sceneId: string | null
  canvasId: string | null
  stepId: string
  stepAttempt: number
  arrangeKey: string
}): string {
  return [
    input.projectId ?? '',
    input.sceneId ?? '',
    input.canvasId ?? '',
    input.stepAttempt,
    input.stepId,
    input.arrangeKey
  ].join('|')
}

export function guideMediaImportOutcomeOf(
  outcome: CatalogImportOutcome,
  kind: GuideAssetCardKind
): GuideMediaImportOutcome {
  switch (outcome.status) {
    case 'imported':
      return outcome.sources.some((source) => source.candidateKind === kind)
        ? 'imported'
        : 'wrong-kind'
    case 'cancelled':
      return 'cancelled'
    case 'unconfirmed':
      return 'unverified'
    case 'not-started':
      return 'unavailable'
    case 'none':
    case 'failed':
      return 'failed'
  }
}

export function guideMediaImportActionOf(
  importFiles: (options?: CatalogImportOptions) => Promise<CatalogImportOutcome>
): GuideMediaImportAction {
  return async (kind) => {
    try {
      return guideMediaImportOutcomeOf(await importFiles({ mediaKinds: [kind] }), kind)
    } catch {
      return 'failed'
    }
  }
}
