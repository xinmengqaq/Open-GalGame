/// <reference types="vite/client" />

/** 由 Vite/Vitest 的 define 注入的应用版本，仅浏览器验证桥使用。 */
declare const __APP_VERSION__: string

interface Window {
  opengalgame?: import('@interfaces/client/DesktopBridge').DesktopBridge
}
