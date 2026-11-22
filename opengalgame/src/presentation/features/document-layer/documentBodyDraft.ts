export const DOCUMENT_BODY_MAX_CHARS = 200000

export type DocumentSaveDraftFailure = 'missing-version' | 'too-long' | 'unsupported-image'

export type DocumentSaveDraftResult =
  { ok: true; body: string } | { ok: false; reason: DocumentSaveDraftFailure }

export function documentsEditable(facts: { contentKind?: string; importFormat?: string }): boolean {
  return facts.contentKind === 'text' && facts.importFormat === 'markdown'
}

export function documentSaveDraft(input: {
  body: string
  expectedVersion?: string | null
  maxChars?: number
}): DocumentSaveDraftResult {
  if (input.body.length > (input.maxChars ?? DOCUMENT_BODY_MAX_CHARS))
    return { ok: false, reason: 'too-long' }
  if (!input.expectedVersion || input.expectedVersion.trim() === '')
    return { ok: false, reason: 'missing-version' }
  if (input.body.includes('draft:') || input.body.includes('blob:'))
    return { ok: false, reason: 'unsupported-image' }
  return { ok: true, body: input.body }
}
