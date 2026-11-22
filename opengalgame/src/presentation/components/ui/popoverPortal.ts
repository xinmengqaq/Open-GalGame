export const POPOVER_Z_INDEX = 60

export interface PopoverPortalTarget {
  container: HTMLElement
  themed: boolean
}

export function resolvePopoverPortal(container?: HTMLElement | null): PopoverPortalTarget | null {
  if (container) return { container, themed: false }
  if (typeof document === 'undefined') return null
  const drawer = document.querySelector<HTMLElement>('.wb-drawer')
  if (drawer) return { container: drawer, themed: false }
  return { container: document.body, themed: true }
}
