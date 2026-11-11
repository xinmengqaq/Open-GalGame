export type CatalogShortcutMenu = 'file' | 'folder' | 'blank' | null

export type CatalogShortcutAction = 'copy-file' | 'cut-file' | 'paste-current' | 'ignore'

/**
 * 文件区快捷键。没有打开文件菜单时不复制、不剪切。
 * 粘贴始终指向当前浏览目录，不用菜单上的文件夹。
 * @param menuKind - 当前菜单种类。没有菜单时为 null。
 */
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
