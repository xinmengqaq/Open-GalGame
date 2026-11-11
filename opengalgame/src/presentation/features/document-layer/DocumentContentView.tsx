import { DocumentEditor } from 'md-blockkit'
import 'md-blockkit/style.css'
import { ImageOff } from 'lucide-react'
import type { ReactElement } from 'react'

import { RefreshIcon } from '../../pages/workbench/WorkbenchIcons'
import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import { sourceDocumentFacts } from '../workbench-session/workbenchSessionMapper'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'
import { useShallow } from 'zustand/react/shallow'

import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionDocumentCard } from '../workbench-session/workbenchSession.types'
import { useDocumentImageCapabilityGuard } from './documentImageCapability'
import type { DocumentBodyView } from './useDocumentLayer'
import styles from './DocumentLayer.module.css'

interface DocumentContentViewProps {
  card: SessionDocumentCard
  view: DocumentBodyView
  editable: boolean
  draft: string | null
  error: string | null
  conflict: boolean
  onChange: (body: string) => void
  onSave: () => void
  reloadLatest: () => void
}

/**
 * 文档正文与阅读侧栏。Markdown 文档可编辑并保存，纯文本保持只读；
 * 加载、失败与空正文分别呈现。
 */
export function DocumentContentView({
  card,
  view,
  editable,
  draft,
  error,
  conflict,
  onChange,
  onSave,
  reloadLatest
}: DocumentContentViewProps): ReactElement {
  const source = useWorkbenchSessionStore(
    useShallow((state) => sourceFactsOf(state, card.sourceId))
  )
  const detail = source.detail?.contentKind === 'text' ? source.detail : undefined
  const facts = sourceDocumentFacts(card, source.detail)
  const sourceName = source.disconnected ? '来源信息不可用' : source.name
  const format =
    facts.importFormat === 'markdown' ? 'Markdown' : facts.importFormat ? '纯文本' : '格式未知'
  const topics = facts.topics
  const showEditor = editable && (view.status === 'ready' || view.status === 'empty')
  const {
    guardRef: documentGuardRef,
    onClickCapture: onDocumentGuardClickCapture,
    onChangeCapture: onDocumentGuardChangeCapture,
    onPasteCapture: onDocumentGuardPasteCapture,
    onDropCapture: onDocumentGuardDropCapture,
    onDragEnterCapture: onDocumentGuardDragEnterCapture,
    onDragOverCapture: onDocumentGuardDragOverCapture
  } = useDocumentImageCapabilityGuard()

  return (
    <div
      className={styles.readingScroll}
      data-selectable
      data-read-state={view.status}
      aria-busy={view.status === 'loading'}
    >
      <article className={styles.article}>
        <div className={styles.articleMeta}>
          <span className={styles.articleLabel}>文档正文</span>
          <span className={styles.articleMetaTags}>
            {showEditor ? (
              <span
                className={styles.imageUnavailableBadge}
                title="文档正文不提供图片能力；已有图片按原样显示"
              >
                <ImageOff aria-hidden="true" />
                不支持插图
              </span>
            ) : null}
            <span className={styles.articleFormat}>{format}</span>
          </span>
        </div>
        {error ? (
          <div className={styles.saveError} role="alert">
            <span className={styles.saveErrorMessage}>{error}</span>
            {conflict ? (
              <button type="button" className={styles.stateAction} onClick={reloadLatest}>
                <RefreshIcon />
                重新读取最新正文
              </button>
            ) : null}
          </div>
        ) : null}
        {view.status === 'loading' ? (
          <div className={styles.loadingState} role="status">
            <p className={styles.stateTitle}>正在读取文档</p>
            <span className={styles.skeletonLine} />
            <span className={styles.skeletonLine} />
            <span className={styles.skeletonLineShort} />
          </div>
        ) : null}
        {view.status === 'failed' ? (
          <div className={styles.statePanel} role="alert">
            <span className={styles.stateMark} aria-hidden="true">
              !
            </span>
            <div>
              <p className={styles.stateTitle}>没能读取这篇文档</p>
              <p className={styles.stateCopy}>{view.message ?? '来源当前不可读取。'}</p>
            </div>
            <button type="button" className={styles.stateAction} onClick={view.retry}>
              <RefreshIcon />
              重新读取
            </button>
          </div>
        ) : null}
        {view.status === 'empty' && !editable ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyMark} aria-hidden="true">
              <ContentKindIcon contentKind="text" textKind="document" />
            </span>
            <p className={styles.stateTitle}>这篇文档还没有正文</p>
            <p className={styles.stateCopy}>正文为空，卡片仍保留在当前画布编排里。</p>
          </div>
        ) : null}
        {showEditor ? (
          <>
            {view.status === 'empty' ? (
              <p className={styles.emptyHint}>这篇文档还没有正文，可以直接开始写。</p>
            ) : null}
            <div
              ref={documentGuardRef}
              className={styles.documentGuard}
              onClickCapture={onDocumentGuardClickCapture}
              onChangeCapture={onDocumentGuardChangeCapture}
              onPasteCapture={onDocumentGuardPasteCapture}
              onDropCapture={onDocumentGuardDropCapture}
              onDragEnterCapture={onDocumentGuardDragEnterCapture}
              onDragOverCapture={onDocumentGuardDragOverCapture}
            >
              <DocumentEditor
                key={`${card.sourceId}:${detail?.version}`}
                className={styles.document + ' ' + styles.editableDocument}
                value={draft ?? view.body}
                onChange={onChange}
                onSaveShortcut={() => onSave()}
                placeholder="编辑正文，保存后写回工程文件"
              />
            </div>
          </>
        ) : null}
        {view.status === 'ready' && !showEditor ? (
          facts.importFormat === 'plainText' ? (
            <div className={styles.plainBody}>{view.body}</div>
          ) : (
            <DocumentEditor
              className={styles.document}
              value={view.body}
              onChange={() => undefined}
              readOnly
            />
          )
        ) : null}
        {view.status === 'ready' ? (
          <div className={styles.documentEnd} aria-hidden="true">
            <span />
            <i>✦</i>
            <span />
          </div>
        ) : null}
      </article>
      <aside className={styles.rail}>
        <p className={styles.railEyebrow}>阅读信息</p>
        <dl className={styles.railList}>
          <div>
            <dt>来源</dt>
            <dd>{sourceName}</dd>
          </div>
          <div>
            <dt>格式</dt>
            <dd>{format}</dd>
          </div>
          <div>
            <dt>主题</dt>
            <dd>{topics.length > 0 ? topics.join(' · ') : '未标注'}</dd>
          </div>
        </dl>
        <p className={styles.railNote}>
          {editable ? '正文保存后会写回工程文件。' : '正文来自工程文件，此处只读。'}
        </p>
        <p className={styles.railShortcut}>Esc 返回画布</p>
      </aside>
    </div>
  )
}
