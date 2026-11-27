const imageFileExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
const audioFileExtensions = ['mp3', 'flac', 'wav']
const containerFileExtensions = ['ogg', 'mp4', 'webm']
const imageExtensions = new Set(imageFileExtensions)
const audioExtensions = new Set(audioFileExtensions)
const containerExtensions = new Set(containerFileExtensions)

export type MediaCategory = 'image' | 'audio' | 'video'

/**
 * 文件名只用于选择器初筛。音视频共用容器不能凭后缀决定轨道，返回
 * container，实际类别仍由导入后的内容识别给出。
 */
export type MediaFileNameCandidate =
  | { status: 'identified'; category: 'image' | 'audio' }
  | { status: 'container' }
  | { status: 'unknown' }

export function classifyMediaFileName(fileName: string): MediaFileNameCandidate {
  const extension = finalExtensionOf(fileName)
  if (isImageFileExtension(extension)) return { status: 'identified', category: 'image' }
  if (isAudioFileExtension(extension)) return { status: 'identified', category: 'audio' }
  if (isContainerFileExtension(extension)) return { status: 'container' }
  return { status: 'unknown' }
}

export function isImageFileExtension(extension: string): boolean {
  return imageExtensions.has(extension)
}

export function isAudioFileExtension(extension: string): boolean {
  return audioExtensions.has(extension)
}

export function isContainerFileExtension(extension: string): boolean {
  return containerExtensions.has(extension)
}

export function mediaExtensionsForCategories(
  categories: readonly MediaCategory[]
): readonly string[] {
  const extensions: string[] = []
  const append = (values: readonly string[]): void => {
    for (const value of values) {
      if (!extensions.includes(value)) extensions.push(value)
    }
  }
  for (const category of categories) {
    if (category === 'image') {
      append(imageFileExtensions)
    } else if (category === 'audio') {
      append(audioFileExtensions)
      append(containerFileExtensions)
    } else {
      append(containerFileExtensions)
    }
  }
  return extensions
}

function finalExtensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}
