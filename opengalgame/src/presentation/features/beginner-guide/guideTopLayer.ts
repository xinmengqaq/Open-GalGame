/**
 * 模态层里留给教程 portal 的挂载点。
 *
 * 生成抽屉与试玩预览都是带焦点陷阱的全屏模态：教程只有挂在对话框内容树内，
 * 才能同时获得正确的绘制层级、焦点范围和可访问树。槽位由各自的 ref 写入，
 * Host 通过 useSyncExternalStore 订阅，避免在效果里轮询 DOM 或同步写状态。
 * 预览与抽屉互斥；同时存在时预览优先，遮住整个工作台的那一层才是当前表面。
 */
let drawerHost: HTMLElement | null = null
let previewHost: HTMLElement | null = null
const drawerListeners = new Set<() => void>()
const previewListeners = new Set<() => void>()

export function setGuideTopLayerHost(next: HTMLElement | null): void {
  if (drawerHost === next) return
  drawerHost = next
  for (const listener of drawerListeners) listener()
}

export function subscribeGuideTopLayerHost(listener: () => void): () => void {
  drawerListeners.add(listener)
  return () => {
    drawerListeners.delete(listener)
  }
}

export function readGuideTopLayerHost(): HTMLElement | null {
  return drawerHost
}

export function setGuidePreviewHost(next: HTMLElement | null): void {
  if (previewHost === next) return
  previewHost = next
  for (const listener of previewListeners) listener()
}

export function subscribeGuidePreviewHost(listener: () => void): () => void {
  previewListeners.add(listener)
  return () => {
    previewListeners.delete(listener)
  }
}

export function readGuidePreviewHost(): HTMLElement | null {
  return previewHost
}
