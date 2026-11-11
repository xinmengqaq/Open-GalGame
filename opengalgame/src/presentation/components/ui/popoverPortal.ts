/**
 * Popover 的 portal 目标解析。与组件分开导出，避免基础控件目录
 * 重新导出非组件值（注册表文件只导出组件）。
 */

/** Sheet 内容使用 z-index 50；浮层必须盖在抽屉内容之上。 */
export const POPOVER_Z_INDEX = 60

export interface PopoverPortalTarget {
  container: HTMLElement
  /** 容器自己不带 `--wb-*` 时，内容外再套一层主题类。 */
  themed: boolean
}

export function resolvePopoverPortal(container?: HTMLElement | null): PopoverPortalTarget | null {
  if (container) return { container, themed: false }
  if (typeof document === 'undefined') return null
  const drawer = document.querySelector<HTMLElement>('.wb-drawer')
  if (drawer) return { container: drawer, themed: false }
  return { container: document.body, themed: true }
}
