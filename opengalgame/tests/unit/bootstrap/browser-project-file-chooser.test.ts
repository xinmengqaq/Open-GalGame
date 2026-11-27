import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserDesktopBridge } from '@bootstrap/browser/BrowserDesktopBridge'

type FakeFileInput = {
  type: string
  multiple: boolean
  hidden: boolean
  accept: string
  value: string
  files: File[]
  setAttribute: (name: string, value: string) => void
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string) => void
  click: () => void
}

function installPickerDocument(): { inputs: FakeFileInput[]; clickedAccepts: string[] } {
  const inputs: FakeFileInput[] = []
  const clickedAccepts: string[] = []
  vi.stubGlobal('window', { location: { search: '' } })
  vi.stubGlobal('document', {
    createElement: () => {
      const listeners = new Map<string, () => void>()
      const input: FakeFileInput = {
        type: '',
        multiple: false,
        hidden: false,
        accept: '',
        value: '',
        files: [],
        setAttribute: () => undefined,
        addEventListener: (type, listener) => {
          listeners.set(type, listener)
        },
        removeEventListener: (type) => {
          listeners.delete(type)
        },
        click: () => {
          clickedAccepts.push(input.accept)
          listeners.get('cancel')?.()
        }
      }
      inputs.push(input)
      return input
    },
    body: { append: () => undefined }
  })
  return { inputs, clickedAccepts }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('浏览器工程文件选择器', () => {
  it('每次按本次请求生成 accept，图片、音频、普通和再次图片选择不互相串过滤', async () => {
    const { inputs, clickedAccepts } = installPickerDocument()
    const bridge = createBrowserDesktopBridge()

    await bridge.chooseProjectFiles({ mediaKinds: ['image'] })
    await bridge.chooseProjectFiles({ mediaKinds: ['audio'] })
    await bridge.chooseProjectFiles()
    await bridge.chooseProjectFiles({ mediaKinds: ['image'] })

    const imageAccept = '.png,.jpg,.jpeg,.gif,.webp,.svg'
    const audioAccept = '.mp3,.flac,.wav,.ogg,.mp4,.webm'
    const normalAccept =
      '.md,.markdown,.txt,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp3,.flac,.wav,.ogg,.mp4,.webm'
    expect(clickedAccepts).toEqual([imageAccept, audioAccept, normalAccept, imageAccept])
    expect(inputs[1]?.accept).toBe(normalAccept)
  })
})
