import type { ReactElement } from 'react'

import styles from './ProjectsPage.module.css'

/** 统一的低对比无封面占位，不随项目 id 变化。 */
export function ProjectCoverPlaceholder(): ReactElement {
  return (
    <svg
      className={styles.coverPlaceholder}
      viewBox="0 0 96 72"
      role="img"
      aria-label="无封面"
      data-cover-placeholder
    >
      <rect x="17.5" y="13.5" width="61" height="45" rx="6" />
      <path d="m24 50 14-13 10 8 8-7 20 14" />
      <circle cx="63" cy="27" r="4" />
    </svg>
  )
}
