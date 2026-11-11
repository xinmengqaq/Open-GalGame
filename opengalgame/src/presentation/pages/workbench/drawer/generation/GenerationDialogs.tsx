import { clsx } from 'clsx'
import { AlertTriangle } from 'lucide-react'
import type { ReactElement } from 'react'

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

export type GenerationDialogKind = 'cancel' | 'discard'

interface GenerationDialogProps {
  kind: GenerationDialogKind | null
  pending: boolean
  failure: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

const copy = {
  cancel: {
    title: '取消本次生成？',
    lead: '会先核对提交结果再结束运行。已保存的画布和输入不会回滚，但本轮候选不会进入作品。',
    confirm: '取消本次生成',
    running: '正在取消'
  },
  discard: {
    title: '丢弃这份候选？',
    lead: '只会丢弃当前候选，不会撤销已经提交的作品，也不会删除已保存的画布。',
    confirm: '丢弃候选',
    running: '正在丢弃'
  }
} as const

/** 取消和丢弃都先确认；确认框只表达当前对象，不宣称撤销已提交作品。 */
export function GenerationDialog({
  kind,
  pending,
  failure,
  onOpenChange,
  onConfirm
}: GenerationDialogProps): ReactElement {
  const text = copy[kind ?? 'cancel']
  return (
    <AlertDialog open={kind !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={clsx('wb-drawer', 'wb-drawer--dialog', 'wb-gen-dialog', theme.theme)}
      >
        <div className="wb-gen-dialog__head">
          <span aria-hidden="true" className="wb-gen-dialog__icon">
            <AlertTriangle />
          </span>
          <div>
            <AlertDialogTitle className="wb-gen-dialog__title">{text.title}</AlertDialogTitle>
            <AlertDialogDescription className="wb-gen-dialog__desc">
              {text.lead}
            </AlertDialogDescription>
          </div>
        </div>
        {failure ? (
          <p className="wb-gen-dialog__failure" role="alert">
            {failure}
          </p>
        ) : null}
        <AlertDialogFooter className="wb-gen-dialog__actions">
          <AlertDialogCancel className="wb-gen-secondary" disabled={pending} type="button">
            先不处理
          </AlertDialogCancel>
          <AlertDialogAction
            className="wb-gen-danger"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
            type="button"
          >
            {pending ? text.running : text.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
