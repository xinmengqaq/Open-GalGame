import { createContext, useContext } from 'react'

export const DialogElementContext = createContext<HTMLElement | null>(null)

export function useDialogElement(): HTMLElement | null {
  return useContext(DialogElementContext)
}
