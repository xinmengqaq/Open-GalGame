import { createHash } from 'node:crypto'

import { configureDiagnosticHash } from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'

export function diagnosticReference(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 12)
}

configureDiagnosticHash(diagnosticReference)
