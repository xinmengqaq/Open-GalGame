/**
 * 判断地址与预期文档是否同一处，忽略 fragment。
 * 经 URL 解析后比较，避免尾斜杠等规范化差异被误判为不同文档。
 * @returns 同一文档时为 true；任一地址无法解析时为 false。
 */
export function isSameDocumentUrl(url: string, expected: string): boolean {
  const target = URL.parse(url)
  const document = URL.parse(expected)
  if (!target || !document) return false
  target.hash = ''
  document.hash = ''
  return target.href === document.href
}
