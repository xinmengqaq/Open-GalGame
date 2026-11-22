import 'vite/client'

declare global {
  const __APP_VERSION__: string

  interface Window {
    opengalgame?: import('@interfaces/client/DesktopBridge').DesktopBridge
  }
}
