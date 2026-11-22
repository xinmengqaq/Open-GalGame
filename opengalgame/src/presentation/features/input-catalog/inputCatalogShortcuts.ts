export type CatalogShortcutMenu = 'file' | 'folder' | 'blank' | null

export type CatalogShortcutAction = 'copy-file' | 'cut-file' | 'paste-current' | 'ignore'

export function catalogShortcutAction(
  key: string,
  menuKind: CatalogShortcutMenu
): CatalogShortcutAction {
  const normalized = key.toLowerCase()
  if (normalized === 'c' || normalized === 'x') {
    if (menuKind !== 'file') return 'ignore'
    return normalized === 'c' ? 'copy-file' : 'cut-file'
  }
  if (normalized === 'v') return 'paste-current'
  return 'ignore'
}
