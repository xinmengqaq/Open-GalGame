import {
  previewErrorMessages,
  previewErrorRecovery
} from '@application/scene-preview/services/impl/previewErrorMapping'
import type { PreviewErrorCode, PreviewErrorVO } from '@application/scene-preview/vo/PreviewErrorVO'

export function runtimeFailure(code: PreviewErrorCode, dialogueId?: string): PreviewErrorVO {
  return {
    code,
    message: previewErrorMessages[code],
    recovery: previewErrorRecovery[code],
    ...(dialogueId === undefined ? {} : { dialogueId })
  }
}
