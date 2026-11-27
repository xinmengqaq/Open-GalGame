import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from 'react'

import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Dialog } from '../../components/Dialog'
import { AppUpdateSection } from '../app-update/AppUpdateSection'
import type { AppUpdateFlow } from '../app-update/useAppUpdate'
import type { SettingsFlow as ConnectionSettingsFlow } from '../connection-settings/useConnectionSettings'
import { AppearanceSaveErrorDialog } from './appearance/AppearanceSaveErrorDialog'
import { AppearanceSettingsSection } from './appearance/AppearanceSettingsSection'
import type { AppearanceFlow } from './appearance/useAppearanceSettings'
import { ConnectionSettingsSection } from './connections/ConnectionSettingsSection'
import { LegalNoticeDialog } from './LegalNoticeDialog'
import {
  SETTINGS_SECTIONS,
  resolveInitialSettingsSection,
  type SettingsSectionId
} from './settingsNavigation'
import styles from './SettingsCenter.module.css'

function SectionIcon({ section }: { section: SettingsSectionId }): ReactElement {
  if (section === 'connection') {
    return (
      <svg className={styles.tabIcon} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9.5 7H7.5a5 5 0 0 0 0 10h2" />
        <path d="M14.5 7h2a5 5 0 0 1 0 10h-2" />
        <path d="M8 12h8" />
      </svg>
    )
  }
  if (section === 'guide-update') {
    return (
      <svg className={styles.tabIcon} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="m15.4 8.6-1.9 4.9-4.9 1.9 1.9-4.9Z" />
      </svg>
    )
  }
  return (
    <svg className={styles.tabIcon} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 3.5v2.1M12 18.4v2.1M3.5 12h2.1M18.4 12h2.1" />
      <path d="m6 6 1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18" />
    </svg>
  )
}

export interface SettingsCenterProps {
  open: boolean
  requestedSection?: SettingsSectionId
  modelConfigured?: boolean
  appearance: AppearanceFlow
  connection: ConnectionSettingsFlow
  appUpdate: AppUpdateFlow
  onClose: () => void
  onRestoreGuideEntry: () => void
}

export function SettingsCenter({
  open,
  requestedSection,
  modelConfigured,
  appearance,
  connection,
  appUpdate,
  onClose,
  onRestoreGuideEntry
}: SettingsCenterProps): ReactElement {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    resolveInitialSettingsSection(requestedSection, modelConfigured)
  )
  const [pendingAction, setPendingAction] = useState<
    { kind: 'close' } | { kind: 'switch'; nextSection: SettingsSectionId } | null
  >(null)
  const [guideEntryRestorePending, setGuideEntryRestorePending] = useState(false)
  const [legalOpen, setLegalOpen] = useState(false)

  const wasOpenRef = useRef(false)
  const openerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({})

  const connectionBusy =
    connection.state === 'testing' ||
    connection.state === 'saving' ||
    connection.state === 'listing'

  const isCurrentSectionDirty = useCallback((): boolean => {
    if (activeSection === 'appearance') return appearance.dirty && !appearance.saving
    if (activeSection === 'connection') return connection.dirty && connection.state !== 'saving'
    return false
  }, [activeSection, appearance.dirty, appearance.saving, connection.dirty, connection.state])

  const restoreFocusOnClose = useCallback((): void => {
    const opener = openerRef.current
    openerRef.current = null
    window.requestAnimationFrame(() => {
      const fallback = document.querySelector<HTMLElement>('[data-settings-opener]')
      const target =
        opener && opener.isConnected && opener.getClientRects().length > 0
          ? opener
          : fallback && fallback.isConnected && fallback.getClientRects().length > 0
            ? fallback
            : null
      if (target && !target.matches(':disabled')) {
        target.focus({ preventScroll: true })
        return
      }
      const heading = document.querySelector<HTMLElement>('h1, [role="heading"][aria-level="1"]')
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
        heading.focus({ preventScroll: true })
      }
    })
  }, [])

  const finishClose = useCallback((): void => {
    setPendingAction(null)
    setGuideEntryRestorePending(false)
    setLegalOpen(false)
    connection.close()
    onClose()
    restoreFocusOnClose()
  }, [connection, onClose, restoreFocusOnClose])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [activeSection, open])

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      openerRef.current =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body &&
        document.activeElement.getClientRects().length > 0
          ? document.activeElement
          : document.querySelector<HTMLElement>('[data-settings-opener]')
      const initial = resolveInitialSettingsSection(requestedSection, modelConfigured)
      setActiveSection(initial)
      setPendingAction(null)
      setGuideEntryRestorePending(false)
      void appearance.load({ syncDraft: false })
      void connection.loadForSection()
    }
    wasOpenRef.current = open
  }, [appearance, connection, modelConfigured, open, requestedSection])

  const requestClose = useCallback((): void => {
    if (isCurrentSectionDirty()) {
      setPendingAction({ kind: 'close' })
      return
    }
    finishClose()
  }, [finishClose, isCurrentSectionDirty])

  const requestSwitchSection = useCallback(
    (nextSection: SettingsSectionId): void => {
      if (nextSection === activeSection) return
      if (isCurrentSectionDirty()) {
        setPendingAction({ kind: 'switch', nextSection })
        return
      }
      setActiveSection(nextSection)
    },
    [activeSection, isCurrentSectionDirty]
  )

  const handleConfirmDiscard = useCallback((): void => {
    if (!pendingAction) return
    if (activeSection === 'appearance') appearance.discardChanges()
    if (activeSection === 'connection') connection.discardChanges()
    if (pendingAction.kind === 'close') {
      finishClose()
      return
    }
    const next = pendingAction.nextSection
    setPendingAction(null)
    setActiveSection(next)
  }, [activeSection, appearance, connection, finishClose, pendingAction])

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let targetIndex: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      targetIndex = (index + 1) % SETTINGS_SECTIONS.length
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      targetIndex = (index - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
    } else if (event.key === 'Home') {
      targetIndex = 0
    } else if (event.key === 'End') {
      targetIndex = SETTINGS_SECTIONS.length - 1
    }
    if (targetIndex === null) return
    event.preventDefault()
    const nextSection = SETTINGS_SECTIONS[targetIndex]
    tabRefs.current[nextSection.id]?.focus()
    requestSwitchSection(nextSection.id)
  }

  const legalAction = (
    <Button variant="secondary" onClick={() => setLegalOpen(true)}>
      关于与许可
    </Button>
  )

  const footer =
    activeSection === 'appearance' ? (
      <div className={styles.footerBar} data-settings-footer>
        <span className={styles.footerStatus} role="status" aria-live="polite">
          {appearance.loadState === 'loading'
            ? '正在读取外观设置…'
            : appearance.loadState === 'error'
              ? '外观设置无法读取'
              : appearance.saving
                ? '正在保存…'
                : appearance.dirty
                  ? '有未保存的更改'
                  : '已与已保存外观同步'}
        </span>
        <div className={styles.footerActions}>
          {legalAction}
          <Button variant="secondary" onClick={requestClose}>
            关闭
          </Button>
          <Button
            data-appearance-save
            disabled={!appearance.canSave}
            onClick={() => void appearance.save()}
          >
            {appearance.saving ? '保存中…' : '保存外观'}
          </Button>
        </div>
      </div>
    ) : activeSection === 'connection' ? (
      <div className={styles.footerBar} data-settings-footer>
        <span className={styles.footerStatus} role="status" aria-live="polite">
          {connection.loadError !== null
            ? '连接设置无法读取'
            : connection.state === 'loading'
              ? '正在读取连接设置…'
              : connectionBusy
                ? connection.state === 'testing'
                  ? '正在测试连接…'
                  : connection.state === 'saving'
                    ? '正在保存…'
                    : '正在拉取模型列表…'
                : connection.dirty
                  ? '有未保存的更改'
                  : connection.summarySource === 'saved'
                    ? '已保存连接设置'
                    : '尚未保存连接设置'}
        </span>
        <div className={styles.footerActions}>
          {legalAction}
          <Button variant="secondary" onClick={requestClose}>
            关闭
          </Button>
          <Button
            variant="secondary"
            data-guide-target="model-test"
            disabled={connection.state !== 'editing' || connection.loadError !== null}
            onClick={() => void connection.testConnection()}
          >
            {connection.state === 'testing' ? '测试中…' : '测试连接'}
          </Button>
          <Button
            data-guide-target="model-save"
            disabled={connection.state !== 'editing' || connection.loadError !== null}
            onClick={() => void connection.saveSettings()}
          >
            {connection.state === 'saving' ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    ) : (
      <div className={styles.footerBar} data-settings-footer data-actions-only="true">
        <div className={styles.footerActions}>
          {legalAction}
          <Button variant="secondary" onClick={requestClose}>
            关闭
          </Button>
        </div>
      </div>
    )

  return (
    <>
      <Dialog
        open={open}
        title="设置"
        size="wide"
        placement="center"
        surface="glass"
        allowClose
        onClose={requestClose}
        actions={footer}
      >
        <div className={styles.layout}>
          <div
            className={styles.nav}
            role="tablist"
            aria-label="设置分区"
            aria-orientation="horizontal"
          >
            {SETTINGS_SECTIONS.map((section, index) => {
              const selected = activeSection === section.id
              return (
                <button
                  key={section.id}
                  ref={(node) => {
                    tabRefs.current[section.id] = node
                  }}
                  id={`settings-tab-${section.id}`}
                  type="button"
                  role="tab"
                  className={styles.tab}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${section.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => requestSwitchSection(section.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <SectionIcon section={section.id} />
                  <span className={styles.tabTitle}>{section.label}</span>
                </button>
              )
            })}
          </div>

          <div ref={contentRef} className={styles.content} data-settings-content>
            {activeSection === 'appearance' ? (
              <section
                id="settings-panel-appearance"
                role="tabpanel"
                aria-labelledby="settings-tab-appearance"
                className={styles.panel}
              >
                <AppearanceSettingsSection flow={appearance} />
              </section>
            ) : null}

            {activeSection === 'connection' ? (
              <section
                id="settings-panel-connection"
                role="tabpanel"
                aria-labelledby="settings-tab-connection"
                className={styles.panel}
              >
                <ConnectionSettingsSection
                  flow={connection}
                  onReload={() => void connection.loadForSection()}
                />
              </section>
            ) : null}

            {activeSection === 'guide-update' ? (
              <section
                id="settings-panel-guide-update"
                role="tabpanel"
                aria-labelledby="settings-tab-guide-update"
                className={styles.panel}
              >
                <div className={styles.guideUpdateSection}>
                  <section className={styles.guideBlock} aria-labelledby="settings-guide-title">
                    <header className={styles.blockHead}>
                      <h3 id="settings-guide-title">新手教程</h3>
                    </header>
                    <Button
                      variant="secondary"
                      className={styles.inlineAction}
                      onClick={() => setGuideEntryRestorePending(true)}
                    >
                      重新显示新手教程入口
                    </Button>
                  </section>
                  <section className={styles.guideBlock} aria-labelledby="settings-update-title">
                    <header className={styles.blockHead}>
                      <h3 id="settings-update-title">版本更新</h3>
                    </header>
                    <AppUpdateSection flow={appUpdate} />
                  </section>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={pendingAction !== null}
        title="放弃未保存的更改？"
        message={
          pendingAction?.kind === 'close'
            ? '当前分区还有未保存的更改。放弃后，本次修改将不会生效。'
            : '切换分区前尚未保存当前更改。放弃后，本次修改将不会保留。'
        }
        confirmLabel={pendingAction?.kind === 'close' ? '放弃并关闭' : '放弃并切换'}
        confirmTone="danger"
        cancelLabel="继续编辑"
        onConfirm={handleConfirmDiscard}
        onCancel={() => setPendingAction(null)}
      />

      <ConfirmDialog
        open={guideEntryRestorePending}
        title="重新显示新手教程入口？"
        message="页面右下角会重新出现教程入口。不会重新开始教程，也不会改动已读进度。已保存的工程和设置不受影响。"
        confirmLabel="显示入口"
        cancelLabel="继续设置"
        onConfirm={() => {
          setGuideEntryRestorePending(false)
          finishClose()
          onRestoreGuideEntry()
        }}
        onCancel={() => setGuideEntryRestorePending(false)}
      />

      <AppearanceSaveErrorDialog flow={appearance} />
      <LegalNoticeDialog open={legalOpen} onClose={() => setLegalOpen(false)} />
    </>
  )
}
