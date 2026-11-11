import type { ReactElement } from 'react'

import { PlusIcon } from '../../components/Icons'
import styles from './ProjectsPage.module.css'

export function NewProjectCard({ onCreate }: { onCreate: () => void }): ReactElement {
  return (
    <div className={styles.cell} data-card-enter>
      <button
        type="button"
        className={`${styles.card} ${styles.newCard}`}
        data-testid="new-project-card"
        onClick={onCreate}
      >
        <span className={styles.emptyCover} aria-hidden="true">
          <PlusIcon className={styles.plus} />
        </span>
        <span className={styles.cardTitle}>新建空白画布</span>
        <span className={styles.cardSynopsis}>从第一句台词开始。</span>
      </button>
    </div>
  )
}
