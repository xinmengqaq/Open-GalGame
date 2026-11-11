import { DocumentEditor } from 'md-blockkit'
import 'md-blockkit/style.css'
import { ImageOff } from 'lucide-react'
import { clsx } from 'clsx'
import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { CreateProjectTextFileDTO } from '@application/project-files/dto/ProjectFilesDTO'
import { Button } from '../../components/Button'
import { TextInput } from '../../components/FormField'
import { Select } from '../../components/Select'
import { BackIcon } from '../../pages/workbench/WorkbenchIcons'
import theme from '../../pages/workbench/workbenchTheme.module.css'
import { useDocumentImageCapabilityGuard } from './documentImageCapability'
import { emptyDocumentSaveDraft, type EmptyDocumentFormat } from './emptyDocumentDraft'
import styles from './DocumentLayer.module.css'

interface EmptyDocumentEditorProps {
  parentFolderId: string | null
  busy: boolean
  onClose: () => void
  onSave: (
    request: Omit<
      CreateProjectTextFileDTO,
      'projectId' | 'expectedCatalogVersion' | 'parentFolderId'
    >
  ) => Promise<void>
}

/** 新建文档的空编辑器。不载入已有卡片正文，也不进入只读文档层。 */
export function EmptyDocumentEditor({
  parentFolderId,
  busy,
  onClose,
  onSave
}: EmptyDocumentEditorProps): ReactElement | null {
  const [fileName, setFileName] = useState('')
  const [format, setFormat] = useState<EmptyDocumentFormat>('markdown')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const {
    guardRef: documentGuardRef,
    onClickCapture: onDocumentGuardClickCapture,
    onChangeCapture: onDocumentGuardChangeCapture,
    onPasteCapture: onDocumentGuardPasteCapture,
    onDropCapture: onDocumentGuardDropCapture,
    onDragEnterCapture: onDocumentGuardDragEnterCapture,
    onDragOverCapture: onDocumentGuardDragOverCapture
  } = useDocumentImageCapabilityGuard()

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function save(): Promise<void> {
    const draft = emptyDocumentSaveDraft({ fileName, format, body })
    if (draft === 'empty-body') {
      setError('正文不能为空')
      return
    }
    if (draft === 'blank-name') {
      setError('文件名无效')
      return
    }
    setError(null)
    await onSave({
      fileName: draft.fileName,
      content: { textKind: 'document', format: draft.format, body: draft.body }
    })
  }

  return createPortal(
    <section
      className={styles.draftLayer}
      aria-label="新建文档"
      data-testid="empty-document-editor"
      data-parent-folder={parentFolderId ?? ''}
    >
      <header className={clsx(styles.header, theme.theme)} data-theme="workbench">
        <Button variant="secondary" className={styles.back} onClick={onClose} disabled={busy}>
          <BackIcon />
          返回画布
        </Button>
        <div className={styles.identity} role="group" aria-label="文档信息">
          <label className={styles.field} htmlFor="empty-document-name">
            <span className={styles.fieldLabel}>文件名</span>
            <TextInput
              id="empty-document-name"
              className={styles.nameInput}
              value={fileName}
              disabled={busy}
              onChange={(event) => setFileName(event.target.value)}
            />
          </label>
          <span className={styles.fieldRule} aria-hidden="true" />
          <label className={styles.field} htmlFor="empty-document-format">
            <span className={styles.fieldLabel}>格式</span>
            <span className={styles.formatControl}>
              <Select
                id="empty-document-format"
                value={format}
                disabled={busy}
                options={[
                  { value: 'markdown', label: 'Markdown' },
                  { value: 'plainText', label: '纯文本' }
                ]}
                onChange={(value) => setFormat(value as EmptyDocumentFormat)}
              />
            </span>
          </label>
          <span
            className={styles.imageUnavailableBadge}
            title="文档正文不提供图片能力；已有图片按原样显示"
          >
            <ImageOff aria-hidden="true" />
            不支持插图
          </span>
          {error ? (
            <span className={styles.fieldError} role="alert">
              {error}
            </span>
          ) : null}
        </div>
        <Button className={styles.save} onClick={() => void save()} disabled={busy}>
          保存到工程
        </Button>
      </header>
      <div
        ref={documentGuardRef}
        className={styles.editor}
        onClickCapture={onDocumentGuardClickCapture}
        onChangeCapture={onDocumentGuardChangeCapture}
        onPasteCapture={onDocumentGuardPasteCapture}
        onDropCapture={onDocumentGuardDropCapture}
        onDragEnterCapture={onDocumentGuardDragEnterCapture}
        onDragOverCapture={onDocumentGuardDragOverCapture}
      >
        <DocumentEditor
          className={`${styles.document} ${styles.editableDocument}`}
          value={body}
          onChange={setBody}
          placeholder="写下新文档，不带入已有卡片正文"
          onSaveShortcut={() => void save()}
        />
      </div>
    </section>,
    document.body
  )
}
