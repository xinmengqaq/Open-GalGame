export type EmptyDocumentFormat = 'markdown' | 'plainText'

export type EmptyDocumentSave =
  { fileName: string; format: EmptyDocumentFormat; body: string } | 'empty-body' | 'blank-name'

export function emptyDocumentSaveDraft(input: {
  fileName: string
  format: EmptyDocumentFormat
  body: string
}): EmptyDocumentSave {
  if (input.body.trim() === '') return 'empty-body'
  if (input.fileName.trim() === '') return 'blank-name'
  const extension = input.format === 'markdown' ? '.md' : '.txt'
  const lower = input.fileName.toLowerCase()
  const fileName =
    lower.endsWith('.md') || lower.endsWith('.txt')
      ? input.fileName
      : `${input.fileName}${extension}`
  return { fileName, format: input.format, body: input.body }
}
