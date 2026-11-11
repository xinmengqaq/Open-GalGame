/** 正文长度上限与后端保存用例一致。 */
export const DOCUMENT_BODY_MAX_CHARS = 200000

export type DocumentSaveDraftFailure = 'missing-version' | 'too-long' | 'unsupported-image'

export type DocumentSaveDraftResult =
  { ok: true; body: string } | { ok: false; reason: DocumentSaveDraftFailure }

/**
 * 只有 Markdown 文档进入可编辑态。纯文本继续按原样只读，不交给 Markdown 编辑器解析。
 * @param facts - 来源内容类别与导入格式；缺一项都视为不可编辑。
 */
export function documentsEditable(facts: { contentKind?: string; importFormat?: string }): boolean {
  return facts.contentKind === 'text' && facts.importFormat === 'markdown'
}

/**
 * 校验文档正文草稿。正文原样返回，不 trim；空正文允许保存。
 * @param input.expectedVersion - 当前来源版本，空白时拒绝保存。
 * @param input.maxChars - 长度上限，缺省与后端一致。
 * @returns 可提交的正文，或拒绝原因。
 */
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
