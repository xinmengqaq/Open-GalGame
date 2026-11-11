import { useRef, useState, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import { DangerAction } from '../../components/DangerAction'
import { Dialog } from '../../components/Dialog'
import { FormField, TextInput } from '../../components/FormField'
import { cardKindLabel, cardTitleText } from '../workbench-session/contentKindLabel'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import { relationLabelOf } from '../workbench-session/workbenchSessionSelectors'
import type { SessionRelation } from '../workbench-session/workbenchSession.types'
import dialogStyles from './RelationDialog.module.css'
import { relationFeedback } from './relationFeedback'
import { RecordIcon } from './SceneCanvasIcons'
import { useRelationDialogMotion } from './useRelationMotion'

interface RelationDialogProps {
  relation: SessionRelation | null
  onClose: () => void
}

/** 线上标签的“特殊关系”弹窗：只编辑可选名称、查看记录并删除连线。 */
export function RelationDialog({ relation, onClose }: RelationDialogProps): ReactElement {
  if (!relation) {
    return (
      <Dialog open={false} title="特殊关系" allowClose onClose={onClose} actions={null}>
        {null}
      </Dialog>
    )
  }
  return <RelationForm key={relation.relationId} relation={relation} onClose={onClose} />
}

function RelationForm({
  relation,
  onClose
}: {
  relation: SessionRelation
  onClose: () => void
}): ReactElement {
  const commands = useWorkbenchCommands()
  const cards = useWorkbenchSessionStore((state) => state.cards)
  const formRef = useRef<HTMLFormElement>(null)
  const [name, setName] = useState(relation.specificName)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'apply' | 'delete' | 'detach' | null>(null)
  const fromCard = cards.find((card) => card.cardId === relation.fromCardId)
  const toCard = cards.find((card) => card.cardId === relation.toCardId)
  const record = relation.recordCardId
    ? (cards.find((card) => card.cardId === relation.recordCardId) ?? null)
    : null
  const recordTitle = record
    ? record.kind === 'prompt'
      ? '提示词记录'
      : cardTitleText(record)
    : null
  const label = relationLabelOf({ cards }, relation)
  const tone = label.kind === 'empty' ? 'unnamed' : 'named'
  const stateText =
    label.kind === 'name' ? '已命名关系' : label.kind === 'empty' ? '未命名关系' : '由记录命名'

  useRelationDialogMotion({
    root: formRef,
    relationId: relation.relationId,
    recordId: relation.recordCardId ?? '',
    tone
  })

  async function applyName(): Promise<void> {
    const next = name.trim()
    if (next === relation.specificName.trim()) {
      onClose()
      return
    }
    setBusy('apply')
    setError(null)
    const applied = await commands.editRelationName(relation.relationId, next)
    setBusy(null)
    if (applied === 'applied') onClose()
    else if (applied === 'failed') setError('关系名称没有保存，请稍后重试。')
  }

  async function removeRelation(): Promise<void> {
    setBusy('delete')
    setError(null)
    const removed = await commands.disconnectCards(relation.relationId)
    setBusy(null)
    if (removed === 'applied') {
      relationFeedback.relationDeleted()
      onClose()
    } else if (removed === 'failed') {
      setError('删除连线未完成，请稍后重试。')
    }
  }

  async function detachRecord(): Promise<void> {
    setBusy('detach')
    setError(null)
    const detached = await commands.detachRelationRecord(relation.relationId)
    setBusy(null)
    if (detached === 'applied') relationFeedback.recordDetached()
    else if (detached === 'failed') setError('卸下关系记录未完成，请稍后重试。')
  }

  return (
    <Dialog
      open
      title="特殊关系"
      size="form"
      allowClose
      onClose={onClose}
      actions={
        <>
          <DangerAction
            label="删除连线"
            className={dialogStyles.deleteAction}
            disabled={busy !== null}
            onClick={() => void removeRelation()}
          />
          <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
            取消
          </Button>
          <Button type="submit" form="relation-name-form" disabled={busy !== null}>
            {busy === 'apply' ? '正在应用' : '完成'}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        id="relation-name-form"
        className={dialogStyles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void applyName()
        }}
      >
        <div className={dialogStyles.intro} data-tone={tone}>
          <span
            className={dialogStyles.accent}
            data-motion="relation-dialog-accent"
            aria-hidden="true"
          />
          <div className={dialogStyles.introHeader}>
            <span className={dialogStyles.stateBadge} data-motion="relation-dialog-chip">
              <span className={dialogStyles.stateMark} aria-hidden="true" />
              {stateText}
            </span>
            <p className={dialogStyles.introNote}>
              连线不分方向。名称与记录都由你填写，系统不推断关系。
            </p>
          </div>
          <div className={dialogStyles.endpoints}>
            <span className={dialogStyles.endpointChip} data-motion="relation-dialog-chip">
              <small>{fromCard ? cardKindLabel(fromCard.kind) : '卡片'}</small>
              <b>{fromCard ? cardTitleText(fromCard) : '卡片已不在画布上'}</b>
            </span>
            <span className={dialogStyles.linkLine} aria-hidden="true" />
            <span className={dialogStyles.endpointChip} data-motion="relation-dialog-chip">
              <small>{toCard ? cardKindLabel(toCard.kind) : '卡片'}</small>
              <b>{toCard ? cardTitleText(toCard) : '卡片已不在画布上'}</b>
            </span>
          </div>
        </div>

        <FormField label="名称" optional="选填" htmlFor="relation-name">
          <TextInput
            id="relation-name"
            autoFocus
            value={name}
            placeholder="例如：青梅竹马、同一场景"
            onChange={(event) => {
              setName(event.target.value)
              if (error) setError(null)
            }}
          />
        </FormField>

        <section className={dialogStyles.section} data-motion="relation-dialog-record">
          <header className={dialogStyles.sectionHeader}>
            <div>
              <h3>关系记录</h3>
              <p>把文档卡或提示词卡外侧的菱形端口拖到线上标签，即可装载。</p>
            </div>
            {relation.recordCardId ? (
              <Button
                variant="secondary"
                className={dialogStyles.detachAction}
                disabled={busy !== null}
                onClick={() => void detachRecord()}
              >
                卸下记录
              </Button>
            ) : null}
          </header>
          {record ? (
            <div className={dialogStyles.record}>
              <span className={dialogStyles.recordIcon} aria-hidden="true">
                <RecordIcon />
              </span>
              <div className={dialogStyles.recordCopy}>
                <small>{cardKindLabel(record.kind)}</small>
                <b>{recordTitle ?? ''}</b>
                {record.kind === 'prompt' && record.body.trim() ? (
                  <p>{record.body.trim().slice(0, 72)}</p>
                ) : null}
              </div>
            </div>
          ) : relation.recordCardId ? (
            <p className={dialogStyles.missing}>记录卡已不在画布上，可以卸下这个引用。</p>
          ) : (
            <p className={dialogStyles.empty}>这条线还没有关系记录。</p>
          )}
        </section>

        {error ? (
          <p className={dialogStyles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
