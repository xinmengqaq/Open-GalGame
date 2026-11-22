export function isSameDocumentUrl(url: string, expected: string): boolean {
  const target = URL.parse(url)
  const document = URL.parse(expected)
  if (!target || !document) return false
  target.hash = ''
  document.hash = ''
  return target.href === document.href
}
