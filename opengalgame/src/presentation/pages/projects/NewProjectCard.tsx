import type { ReactElement } from 'react'

import { PlusIcon } from '../../components/Icons'
import { NewProjectArtwork } from './ProjectsStateArtwork'
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
        <span className={`${styles.coverWrap} ${styles.newCover}`}>
          <NewProjectArtwork />
          <span className={styles.newOrb} aria-hidden="true">
            <PlusIcon className={styles.plus} />
          </span>
        </span>
        <span className={styles.cardCopy}>
          <span className={styles.cardTitle}>新建空白画布</span>
          <span className={styles.cardSynopsis}>从第一句台词开始。</span>
        </span>
      </button>
    </div>
  )
}
