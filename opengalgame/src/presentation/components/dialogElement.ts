import { createContext, useContext } from 'react'

export const DialogElementContext = createContext<HTMLElement | null>(null)

/**
 * 取当前弹窗元素。原生 dialog 打开后位于 top layer，弹窗内的浮层若 portal 到 body
 * 会被压在弹窗之下，且被弹窗滚动区裁掉，因此以弹窗自身作为 portal 容器。
 * @returns 弹窗元素；不在弹窗内时为 null。
 */
export function useDialogElement(): HTMLElement | null {
  return useContext(DialogElementContext)
}
