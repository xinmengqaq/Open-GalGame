import { clsx } from 'clsx'
import { useState, type ReactElement } from 'react'

import { CardEditIcon } from './InputCardIcons'
import { PromptEditor } from './PromptEditor'
import styles from './SceneInputCards.module.css'
import type { SessionPromptCard } from '../workbench-session/workbenchSession.types'

/**
 * 提示词卡片只有正文和卡片引用，没有标题、简介或额外说明。
 * 展示态整卡可拖动，双击进入正文编辑；编辑态交给 PromptEditor，
 * 卡面与编辑器根节点都不再参与画布拖动。
 */
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
