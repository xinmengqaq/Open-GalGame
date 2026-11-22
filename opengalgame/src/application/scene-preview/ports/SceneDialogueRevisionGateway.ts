import type { DialogueEditPlan } from '@domain/scene-preview/models/DialogueEditPlan'

import type { ScenePreviewSourceFact } from '../models/ScenePreviewSourceFact'

export type PreparedDialogueRevision = {
  readonly relativePath: string
  readonly bytes: Uint8Array
  readonly digest: string
}

export interface SceneDialogueRevisionGateway {
  prepareDialogueRevision(
    source: ScenePreviewSourceFact,
    plan: DialogueEditPlan
  ): Promise<PreparedDialogueRevision>
}
