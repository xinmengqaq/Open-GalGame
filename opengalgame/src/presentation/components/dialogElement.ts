import { createContext, useContext } from 'react'

export const DialogElementContext = createContext<HTMLElement | null>(null)

export function useDialogElement(): HTMLElement | null {
  return useContext(DialogElementContext)
}

const modalStack: HTMLDialogElement[] = []
const subscribers = new Set<() => void>()

export function registerPageModal(dialog: HTMLDialogElement): () => void {
  modalStack.push(dialog)
  subscribers.forEach((notify) => notify())
  return () => {
    modalStack.splice(modalStack.indexOf(dialog), 1)
    subscribers.forEach((notify) => notify())
  }
}

export const currentPageModal = (): HTMLDialogElement | null => modalStack.at(-1) ?? null

export function subscribePageModal(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}
