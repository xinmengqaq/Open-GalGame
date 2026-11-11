import { clsx } from 'clsx'
import { AlertTriangle } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'

import type { ClearVersionHistoryDTO } from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { VersionHistoryEntryVO } from '@application/project-versioning/vo/VersionHistoryVO'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle
} from '@presentation/components/ui/alert-dialog'
import theme from '../../workbenchTheme.module.css'
import {
  contentSourceLabel,
  formatHistoryTime,
  historyFeedback,
  saveModeLabel,
  type HistoryActionFailure
} from './versionHistoryPresentation'
import './dialogs.css'

interface HistoryDialogShellProps {
  open: boolean
  title: string
  lead: string
  entry: VersionHistoryEntryVO | null
  notes?: readonly ReactNode[]
  caveat?: string
  blockedReason: string | null
  failure: HistoryActionFailure | null
  actionLabel: string
  runningLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  onReloadHistory: () => void
}

function HistoryDialogShell({
  open,
  title,
  lead,
  entry,
  notes,
  caveat,
  blockedReason,
  failure,
  actionLabel,
  runningLabel,
  busy,
  onCancel,
  onConfirm,
  onReloadHistory
}: HistoryDialogShellProps): ReactElement {
  const unverified = failure?.unverified === true
  const visibleNotes = (notes ?? []).filter(Boolean)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent
        className={clsx('wb-drawer', 'wb-drawer--dialog', 'works-dialog', theme.theme)}
      >
        <div className="works-dialog__head">
          <span aria-hidden="true" className="works-dialog__icon">
            <AlertTriangle />
          </span>
          <div className="works-dialog__copy">
            <AlertDialogTitle className="works-dialog__title">{title}</AlertDialogTitle>
            <AlertDialogDescription className="works-dialog__desc">{lead}</AlertDialogDescription>
          </div>
        </div>

        {entry ? (
          <div className="works-dialog__target">
            <strong>{entry.title}</strong>
            <span>
              {formatHistoryTime(entry.createdAt)} · {saveModeLabel(entry.saveMode)} ·{' '}
              {contentSourceLabel(entry.contentSource)}
            </span>
          </div>
        ) : null}

        {visibleNotes.length > 0 ? (
          <ul className="works-dialog__scope">
            {visibleNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        ) : null}

        {caveat ? <p className="works-dialog__caveat">{caveat}</p> : null}

        {blockedReason ? (
          <p className="works-dialog__blocked" role="status">
            {blockedReason}
          </p>
        ) : null}

        {failure ? (
          <p className="works-dialog__failure" role="alert">
            {failure.msg}
          </p>
        ) : null}

        <AlertDialogFooter className="works-dialog__actions">
          {unverified ? (
            <button
              className="works-secondary"
              disabled={busy}
              onClick={onReloadHistory}
              type="button"
            >
              {historyFeedback.retry}
            </button>
          ) : null}
          <AlertDialogCancel className="works-secondary" disabled={busy}>
            {unverified ? historyFeedback.close : '取消'}
          </AlertDialogCancel>
          <AlertDialogAction
            className="works-danger works-danger--solid"
            disabled={busy || blockedReason !== null || unverified}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {busy ? runningLabel : actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface UndoConfirmDialogProps {
  open: boolean
  entry: VersionHistoryEntryVO | null
  hasUnsavedEdits: boolean
  busy: boolean
  blockedReason: string | null
  failure: HistoryActionFailure | null
  onCancel: () => void
  onConfirm: () => void
  onReloadHistory: () => void
}

export function UndoConfirmDialog({
  open,
  entry,
  hasUnsavedEdits,
  busy,
  blockedReason,
  failure,
  onCancel,
  onConfirm,
  onReloadHistory
}: UndoConfirmDialogProps): ReactElement {
  return (
    <HistoryDialogShell
      actionLabel={historyFeedback.undoConfirmAction}
      blockedReason={blockedReason}
      busy={busy}
      entry={entry}
      failure={failure}
      lead={historyFeedback.undoConfirmLead}
      notes={[
        historyFeedback.undoConflictNote,
        hasUnsavedEdits ? historyFeedback.undoDraftNote : null
      ]}
      onCancel={onCancel}
      onConfirm={onConfirm}
      onReloadHistory={onReloadHistory}
      open={open}
      runningLabel={historyFeedback.undoRunning}
      title={historyFeedback.undoConfirmTitle}
    />
  )
}

interface ClearConfirmDialogProps {
  open: boolean
  entry: VersionHistoryEntryVO | null
  selection: ClearVersionHistoryDTO['selection'] | null
  busy: boolean
  blockedReason: string | null
  failure: HistoryActionFailure | null
  onCancel: () => void
  onConfirm: () => void
}

export function ClearConfirmDialog({
  open,
  entry,
  selection,
  busy,
  blockedReason,
  failure,
  onCancel,
  onConfirm
}: ClearConfirmDialogProps): ReactElement {
  const category = selection?.kind === 'category'
  return (
    <HistoryDialogShell
      actionLabel={
        category ? historyFeedback.clearCategoryAction : historyFeedback.clearEntryAction
      }
      blockedReason={blockedReason}
      busy={busy}
      caveat={category ? historyFeedback.clearCategoryContent : undefined}
      entry={entry}
      failure={failure}
      lead={category ? historyFeedback.clearCategoryLead : historyFeedback.clearEntryLead}
      notes={
        category
          ? [
              historyFeedback.clearCategoryUnknownPage,
              historyFeedback.clearCategoryAfter,
              historyFeedback.clearCategoryCount
            ]
          : []
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
      onReloadHistory={onCancel}
      open={open}
      runningLabel={historyFeedback.clearRunning}
      title={
        category && entry
          ? historyFeedback.clearCategoryTitle(entry.saveMode)
          : historyFeedback.clearEntryTitle
      }
    />
  )
}
