import type { ReactElement } from 'react'

import { SourceStatus } from '../../components/SourceStatus'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogSourceStatusProps {
  readable: boolean
}

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
