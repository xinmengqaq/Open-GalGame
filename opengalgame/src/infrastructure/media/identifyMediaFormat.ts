import { XMLParser, XMLValidator } from 'fast-xml-parser'

const imageExtensions = new Set(['png', 'jpg', 'gif', 'webp'])
const audioExtensions = new Set(['mp3', 'flac', 'wav'])
const containerExtensions = new Set(['ogg', 'mp4', 'webm'])
const svgNamespace = 'http://www.w3.org/2000/svg'

export type MediaCategory = 'image' | 'audio' | 'video'

export type MediaFormatIdentification =
  | { supported: true; category: MediaCategory; extension: string; mediaType: string }
  | { supported: false; reason: 'unsupported' | 'ambiguous' }

/**
 * 识别缓冲区的媒体类别。
 * SVG 走 XML 结构校验；共用容器只接受明确的音频或视频 MIME。
 * @returns 受支持的类别，或不受支持、无法区分的结果。
 */
export async function identifyMediaFormat(bytes: Uint8Array): Promise<MediaFormatIdentification> {
  const binary = await identifyBinary(bytes)
  if (binary) return binary
  if (isSvgDocument(bytes)) {
    return { supported: true, category: 'image', extension: 'svg', mediaType: 'image/svg+xml' }
  }
  return { supported: false, reason: 'unsupported' }
}

export function mediaFormatMatchesFileType(
  fileType: string,
  identification: MediaFormatIdentification
): boolean {
  return identification.supported && identification.category === fileType
}

async function identifyBinary(bytes: Uint8Array): Promise<MediaFormatIdentification | undefined> {
  const { fileTypeFromBuffer } = await import('file-type')
  const detected = await fileTypeFromBuffer(bytes)
  if (!detected) return undefined
  if (imageExtensions.has(detected.ext)) {
    return { supported: true, category: 'image', extension: detected.ext, mediaType: detected.mime }
  }
  if (audioExtensions.has(detected.ext)) {
    return { supported: true, category: 'audio', extension: detected.ext, mediaType: detected.mime }
  }
  if (!containerExtensions.has(detected.ext)) return { supported: false, reason: 'unsupported' }
  if (detected.mime.startsWith('audio/')) {
    return { supported: true, category: 'audio', extension: detected.ext, mediaType: detected.mime }
  }
  if (detected.mime.startsWith('video/')) {
    return { supported: true, category: 'video', extension: detected.ext, mediaType: detected.mime }
  }
  return { supported: false, reason: 'ambiguous' }
}

function isSvgDocument(bytes: Uint8Array): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return false
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) return false
  const validation = XMLValidator.validate(text, { allowBooleanAttributes: false })
  if (validation !== true) return false
  const parser = new XMLParser({
    ignoreAttributes: false,
    allowBooleanAttributes: false,
    processEntities: false,
    htmlEntities: false,
    ignoreDeclaration: true
  })
  const document: unknown = parser.parse(text)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return false
  const keys = Object.keys(document).filter((key) => !key.startsWith('?'))
  if (keys.length !== 1) return false
  const key = keys[0]!
  const localName = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key
  if (localName !== 'svg') return false
  const root = (document as Record<string, unknown>)[key]
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return false
  return svgRootNamespace(key, root as Record<string, unknown>) === svgNamespace
}

function svgRootNamespace(key: string, root: Record<string, unknown>): unknown {
  const separator = key.indexOf(':')
  if (separator === -1) return root['@_xmlns']
  return root[`@_xmlns:${key.slice(0, separator)}`]
}
