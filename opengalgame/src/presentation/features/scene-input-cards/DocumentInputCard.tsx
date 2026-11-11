import type { ReactElement } from 'react'

import { useShallow } from 'zustand/react/shallow'

import { FormatStatus } from '../../components/SourceStatus'
import { CardArrowIcon } from './InputCardIcons'
import styles from './SceneInputCards.module.css'
import { sourceDocumentFacts } from '../workbench-session/workbenchSessionMapper'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'

import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionDocumentCard } from '../workbench-session/workbenchSession.types'

/** 文档卡片内容。只展示身份、简介和文档格式，阅读入口在卡片底部操作槽。 */
export function DocumentInputCard({ card }: { card: SessionDocumentCard }): ReactElement {
  const source = useWorkbenchSessionStore(
    useShallow((state) => sourceFactsOf(state, card.sourceId))
  )
  const facts = sourceDocumentFacts(card, source.detail)
  const summary = card.summary.trim().length > 0 ? card.summary : null
  const format =
    facts.importFormat === 'markdown'
      ? 'Markdown'
      : facts.importFormat === 'plainText'
        ? '纯文本'
        : null
  return (
    <div className={styles.cardBody}>
      <div className={styles.cardCopy}>
        <h3 className={styles.title}>{card.title}</h3>
        {summary ? <p className={styles.summary}>{summary}</p> : null}
      </div>
      <div className={styles.documentMeta}>
        {facts.topics.length > 0 ? (
          <ul className={styles.tags}>
            {facts.topics.map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
        ) : null}
        <FormatStatus format={format} />
      </div>
    </div>
  )
}

/** 文档阅读入口。位于卡片底部独立操作槽，不与来源状态抢位置。 */
export function DocumentReadAction({ onOpen }: { onOpen: () => void }): ReactElement {
  return (
    <button
      type="button"
      className={`${styles.readDocument} nodrag nopan`}
      onClick={onOpen}
      onDoubleClick={(event) => event.stopPropagation()}
      aria-label="阅读文档，打开文档层"
    >
      <span>阅读文档</span>
      <CardArrowIcon />
    </button>
  )
}
