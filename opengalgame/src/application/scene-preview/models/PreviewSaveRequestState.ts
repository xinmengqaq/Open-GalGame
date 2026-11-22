import type { DialogueTextEditDTO } from '../dto/DialogueSaveDTO'
import type { DialogueSaveRequestIdentityVO, DialogueSaveSettlementVO } from '../vo/DialogueSaveVO'

export function previewSaveEditsSnapshot(edits: readonly DialogueTextEditDTO[]): string {
  return JSON.stringify(edits.map((edit) => ({ dialogueId: edit.dialogueId, text: edit.text })))
}

export type PreviewSaveRequestBinding = {
  readonly identity: DialogueSaveRequestIdentityVO
  readonly baseDigest: string
  readonly editsSnapshot: string
}

export type PreviewSaveRequestState =
  | ({ readonly phase: 'inFlight' } & PreviewSaveRequestBinding)
  | ({
      readonly phase: 'settled'
      readonly settlement: DialogueSaveSettlementVO
    } & PreviewSaveRequestBinding)
