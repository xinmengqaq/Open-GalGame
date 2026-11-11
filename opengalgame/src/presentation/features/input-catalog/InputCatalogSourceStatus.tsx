import type { ReactElement } from 'react'

import { SourceStatus } from '../../components/SourceStatus'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogSourceStatusProps {
  readable: boolean
}

/**
 * 目录行内的来源可读状态。薄的测试与布局适配层，
 * 视觉、图标和颜色全部复用共享 SourceStatus，不在目录复制一套状态样式。
 */
export function InputCatalogSourceStatus({
  readable
}: InputCatalogSourceStatusProps): ReactElement {
  return (
    <span
      className={styles.sourceStatusSlot}
      data-readable={readable ? 'true' : 'false'}
      data-testid="catalog-source-status"
    >
      <SourceStatus code={readable ? 'readable' : 'unreadable'} density="compact" motion />
    </span>
  )
}
