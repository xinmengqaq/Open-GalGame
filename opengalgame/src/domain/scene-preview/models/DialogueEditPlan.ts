import type { SceneIdentity } from '../../scenes/models/SceneIdentity'

import type { DialogueTextEdit } from './DialogueTextEdit'

export type DialogueEditPlan = {
  readonly scene: SceneIdentity
  readonly changedEdits: readonly DialogueTextEdit[]
  readonly unchangedEdits: readonly DialogueTextEdit[]
}
