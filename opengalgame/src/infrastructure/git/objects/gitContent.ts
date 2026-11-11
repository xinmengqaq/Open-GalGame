import { createHash, timingSafeEqual } from 'node:crypto'

export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 按字节比较两段内容，长度不同直接为 false。 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

export function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * 从提交记录还原字节。编码不闭合时返回 null，避免把损坏记录当成空文件。
 * @returns 原始字节；无法还原时为 null。
 */
export function decodeBytes(value: string): Uint8Array | null {
  if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  const canonical = decoded.toString('base64').replace(/=+$/u, '')
  if (canonical !== value.replace(/=+$/u, '')) return null
  return new Uint8Array(decoded)
}
