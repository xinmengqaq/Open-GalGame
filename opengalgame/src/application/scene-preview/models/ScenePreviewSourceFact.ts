import type { ParsedScene } from '../../scenes/models/ParsedScene'
import type { SceneReferenceFact } from '../../scenes/models/SceneReferenceFact'
import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'
import type { SceneSourceSnapshot } from '../../scenes/models/SceneSourceSnapshot'
import type {
  SceneContentBasisVO,
  ScenePreviewIssueVO,
  ScenePreviewLockState
} from '../vo/ScenePreviewSessionVO'

export type ScenePreviewDialogueFact = {
  readonly dialogueId: string
  readonly text: string
  readonly located: boolean
}

export type ScenePreviewSourceFact = {
  readonly location: SceneSourceLocation
  readonly snapshot: SceneSourceSnapshot
  readonly parsed: ParsedScene
  readonly references: readonly SceneReferenceFact[]
  readonly contentBasis: SceneContentBasisVO
  readonly lockState: ScenePreviewLockState
  readonly sceneName: string
  readonly dialogues: readonly ScenePreviewDialogueFact[]
  readonly issues: readonly ScenePreviewIssueVO[]
}
