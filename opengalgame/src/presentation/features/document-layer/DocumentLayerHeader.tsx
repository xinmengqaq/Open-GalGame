import type { ReactElement, RefObject } from 'react'
import { clsx } from 'clsx'

import { BackIcon } from '../../pages/workbench/WorkbenchIcons'
import theme from '../../pages/workbench/workbenchTheme.module.css'
import { sourceDocumentFacts } from '../workbench-session/workbenchSessionMapper'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'
import { useShallow } from 'zustand/react/shallow'

import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionDocumentCard } from '../workbench-session/workbenchSession.types'
import styles from './DocumentLayer.module.css'

interface DocumentLayerHeaderProps {
  card: SessionDocumentCard
  onBack: () => void
  backButtonRef: RefObject<HTMLButtonElement | null>
  titleId: string
  editable: boolean
  dirty: boolean
  saving: boolean
  error: string | null
  onSave: () => void
}

export function DocumentLayerHeader({
  card,
  onBack,
  backButtonRef,
  titleId,
  editable,
  dirty,
  saving,
  error,
  onSave
}: DocumentLayerHeaderProps): ReactElement {
  const source = useWorkbenchSessionStore(
    useShallow((state) => sourceFactsOf(state, card.sourceId))
  )
  const facts = sourceDocumentFacts(card, source.detail)
  const sourceName = source.disconnected ? '来源信息不可用' : source.name
  const format =
    facts.importFormat === 'markdown' ? 'Markdown' : facts.importFormat ? '纯文本' : '格式未知'
  const sourceState = source.disconnected
    ? '来源已断开'
    : source.readable
      ? '来源可读取'
      : '来源不可读取'
  const saveState = saving ? '保存中…' : error ? '保存失败' : dirty ? '未保存' : null
  return (
    <header className={clsx(styles.readingHeader, theme.theme)} data-theme="workbench">
      <button ref={backButtonRef} type="button" className={styles.backButton} onClick={onBack}>
        <BackIcon />
        返回画布
      </button>
      <div className={styles.identity}>
        <p className={styles.kicker}>{editable ? '文档' : '只读文档'}</p>
        <h2 id={titleId} className={styles.title}>
          {card.title}
        </h2>
        <p className={styles.identityMeta}>
          <span>{sourceName}</span>
          <span className={styles.metaDivider} aria-hidden="true" />
          <span>{format}</span>
          <span className={styles.metaDivider} aria-hidden="true" />
          <span data-source-state={source.disconnected ? 'bad' : source.readable ? 'ok' : 'bad'}>
            {sourceState}
          </span>
        </p>
      </div>
      {editable ? (
        <div className={styles.headerActions}>
          {saveState ? (
            <span
              className={styles.saveState}
              data-tone={error && !saving ? 'error' : 'normal'}
              title={error ?? undefined}
            >
              {saveState}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.save}
            disabled={!dirty || saving}
            onClick={onSave}
          >
            保存
          </button>
        </div>
      ) : (
        <span className={styles.readOnlyBadge}>
          <span aria-hidden="true" />
          只读阅读
        </span>
      )}
    </header>
  )
}
