import type { DialogueTextEditDTO } from '../dto/DialogueSaveDTO'
import type { DialogueSaveRequestIdentityVO, DialogueSaveSettlementVO } from '../vo/DialogueSaveVO'

/**
 * 按请求顺序保留台词身份和原样正文。
 * 顺序或任一字不同都是另一份负载，不能复用原 `requestId`。
 */
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
