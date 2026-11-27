import type { ReactElement } from 'react'

import styles from './GuideStepOverlay.module.css'

export type GuideCopySegment = {
  text: string
  emphasis: boolean
}

/**
 * 教程文案里的「按钮名」统一用直角引号标出。只把这些成对引号内的动作名
 * 交给强调样式，其余文字保持原样；未闭合的引号不猜测范围。
 */
export function guideCopySegments(text: string): readonly GuideCopySegment[] {
  const segments: GuideCopySegment[] = []
  const pattern = /「[^」\n]+」/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), emphasis: false })
    }
    segments.push({ text: match[0], emphasis: true })
    cursor = index + match[0].length
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), emphasis: false })
  }
  return segments
}

/** 正文里的重点动作名使用主题强调色和字重；不额外加图标或背景。 */
export function GuideCopyText({ text }: { text: string }): ReactElement {
  return (
    <>
      {guideCopySegments(text).map((segment, index) =>
        segment.emphasis ? (
          <strong key={index} className={styles.emphasis}>
            {segment.text}
          </strong>
        ) : (
          segment.text
        )
      )}
    </>
  )
}
