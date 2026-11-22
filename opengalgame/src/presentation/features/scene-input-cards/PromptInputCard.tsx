import { clsx } from 'clsx'
import { useState, type ReactElement } from 'react'

import { CardEditIcon } from './InputCardIcons'
import { PromptEditor } from './PromptEditor'
import styles from './SceneInputCards.module.css'
import type { SessionPromptCard } from '../workbench-session/workbenchSession.types'

export function PromptInputCard({ card }: { card: SessionPromptCard }): ReactElement {
  const [editing, setEditing] = useState(false)

  return (
    <article
      className={clsx(styles.promptCard, editing && 'nodrag nopan nowheel')}
      data-editing={editing ? 'true' : undefined}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (editing) return
        setEditing(true)
      }}
    >
      <span className={styles.promptQuote} aria-hidden="true">
        “
      </span>
      {editing ? null : (
        <span className={styles.promptEditHint} aria-hidden="true">
          <CardEditIcon className={styles.promptEditHintIcon} />
          双击编辑
        </span>
      )}
      <PromptEditor
        cardId={card.cardId}
        value={card.body}
        editing={editing}
        onExitEditing={() => setEditing(false)}
      />
    </article>
  )
}
