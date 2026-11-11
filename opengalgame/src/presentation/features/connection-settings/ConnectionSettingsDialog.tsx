import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import { DangerAction } from '../../components/DangerAction'
import { Dialog } from '../../components/Dialog'
import { FormField, TextArea, TextInput } from '../../components/FormField'
import { PlusIcon } from '../../components/Icons'
import { Select } from '../../components/Select'
import { StatusPanel } from '../../components/StatusPanel'
import styles from './ConnectionSettingsDialog.module.css'
import { extensionProviderHint } from './extensionHints'
import type { SettingsFlow } from './useConnectionSettings'

type ExtensionFocusTarget = 'editor' | 'entry' | 'replace' | 'clear' | 'confirm' | 'undo'

function extensionFocusId(target: ExtensionFocusTarget, hasExtension: boolean): string {
  switch (target) {
    case 'editor':
      return 'extension-json'
    case 'entry':
      return hasExtension ? 'connection-extension-replace' : 'connection-extension-entry'
    case 'replace':
      return 'connection-extension-replace'
    case 'clear':
      return 'connection-extension-clear'
    case 'confirm':
      return 'connection-extension-clear-confirm'
    case 'undo':
      return 'connection-extension-clear-undo'
  }
}

export function ConnectionSettingsDialog({ flow }: { flow: SettingsFlow }): ReactElement {
  const open = flow.state !== 'closed'
  const busy = flow.state === 'testing' || flow.state === 'saving' || flow.state === 'listing'
  const showForm = flow.state === 'editing' || busy
  const modelOptions = flow.models.map((id) => ({ value: id, label: id }))
  if (flow.model && !flow.models.includes(flow.model)) {
    modelOptions.unshift({ value: flow.model, label: flow.model })
  }

  const extensionFocus = useRef<ExtensionFocusTarget | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  function close(): void {
    setFeedbackOpen(false)
    flow.close()
  }

  async function submit(): Promise<void> {
    if (await flow.saveSettings()) close()
  }

  useEffect(() => {
    const target = extensionFocus.current
    if (!target) return
    extensionFocus.current = null
    document.getElementById(extensionFocusId(target, flow.hasExtension))?.focus()
  }, [
    flow.extensionEditorOpen,
    flow.extensionClearConfirming,
    flow.extensionMode,
    flow.hasExtension
  ])

  function focusExtension(target: ExtensionFocusTarget): void {
    extensionFocus.current = target
  }

  return (
    <>
      <Dialog
        open={open}
        title="连接设置"
        size="wide"
        allowClose={!busy}
        onClose={close}
        actions={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              取消
            </Button>
            {flow.state === 'load-error' ? (
              <Button onClick={() => void flow.open()}>重新加载</Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => void flow.testConnection()}
                  disabled={flow.state !== 'editing'}
                >
                  {flow.state === 'testing' ? '测试中…' : '测试连接'}
                </Button>
                <Button onClick={() => void submit()} disabled={flow.state !== 'editing'}>
                  {flow.state === 'saving' ? '保存中…' : '保存'}
                </Button>
              </>
            )}
          </>
        }
      >
        {flow.state === 'loading' ? (
          <div className={styles.loadingPanel} role="status" aria-live="polite">
            <div className={styles.loadingHead}>
              <span className={styles.loadingPulse} aria-hidden="true" />
              正在读取已保存的连接设置…
            </div>
            <div className={styles.skeletonRows} aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => (
                <span key={index} className={styles.skeletonRow} />
              ))}
            </div>
            <p className={styles.loadingHint}>首次读取可能需要几秒；完成后会回显已保存的配置。</p>
          </div>
        ) : null}
        {showForm && flow.summarySource !== 'saved' ? (
          <p className={styles.summaryNote} data-tone={flow.summarySource}>
            {flow.summarySource === 'session'
              ? '磁盘摘要暂未返回，当前显示本次会话保存的配置。'
              : '还没有保存连接设置，填写后保存。'}
          </p>
        ) : null}
        {flow.status && flow.state !== 'load-error' ? (
          <button
            type="button"
            className={styles.feedbackEntry}
            data-tone={flow.status.kind}
            onClick={() => setFeedbackOpen(true)}
          >
            <span className={styles.feedbackDot} aria-hidden="true" />
            <span className={styles.feedbackCopy}>
              <span className={styles.feedbackLabel}>上次操作</span>
              <span className={styles.feedbackTitle}>{flow.status.title}</span>
            </span>
            <span className={styles.feedbackAction}>查看</span>
          </button>
        ) : null}
        {showForm ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <FormField label="协议" htmlFor="provider-id">
              <Select
                id="provider-id"
                value={flow.providerId}
                onChange={(value) => flow.setProviderId(value as typeof flow.providerId)}
                options={[
                  { value: 'openai-compatible', label: 'OpenAI 兼容' },
                  { value: 'anthropic', label: 'Anthropic' }
                ]}
              />
            </FormField>
            <FormField label="上游地址" htmlFor="base-url">
              <TextInput
                id="base-url"
                value={flow.baseUrl}
                onChange={(event) => flow.setBaseUrl(event.target.value)}
              />
            </FormField>
            <FormField label="模型" htmlFor="model-id">
              <div className={styles.modelRow}>
                {flow.models.length > 0 ? (
                  <Select
                    id="model-id"
                    value={flow.model}
                    options={modelOptions}
                    disabled={busy}
                    onChange={flow.setModel}
                  />
                ) : (
                  <TextInput
                    id="model-id"
                    value={flow.model}
                    disabled={busy}
                    onChange={(event) => flow.setModel(event.target.value)}
                  />
                )}
                <Button variant="secondary" disabled={busy} onClick={() => void flow.listModels()}>
                  {flow.state === 'listing' ? '拉取中…' : '拉取列表'}
                </Button>
              </div>
            </FormField>
            <FormField label="API Key" htmlFor="api-key">
              <TextInput
                id="api-key"
                type="password"
                autoComplete="off"
                value={flow.apiKey}
                placeholder={flow.hasApiKey ? '已配置密钥，留空则保留' : '请勿在界面中长期保存密钥'}
                onChange={(event) => flow.setApiKey(event.target.value)}
              />
            </FormField>
            <FormField label="上下文窗口" htmlFor="context-window">
              <TextInput
                id="context-window"
                inputMode="numeric"
                value={flow.contextWindow}
                onChange={(event) => flow.setContextWindow(event.target.value)}
              />
            </FormField>
            <FormField label="最大输出 token" htmlFor="max-output">
              <TextInput
                id="max-output"
                inputMode="numeric"
                aria-describedby="max-output-hint"
                value={flow.maxOutputTokens}
                onChange={(event) => flow.setMaxOutputTokens(event.target.value)}
              />
              <span id="max-output-hint" className={styles.extensionHint}>
                供应商可能限制最大输出；被拒绝时请调低此值并重新测试。
              </span>
            </FormField>
            <FormField label="温度" optional="与 top-p 二选一" htmlFor="temperature">
              <TextInput
                id="temperature"
                value={flow.temperature}
                onChange={(event) => flow.setTemperature(event.target.value)}
              />
            </FormField>
            <FormField label="top-p" htmlFor="top-p">
              <TextInput
                id="top-p"
                value={flow.topP}
                onChange={(event) => flow.setTopP(event.target.value)}
              />
            </FormField>
            <section className={styles.extension} aria-labelledby="connection-extension-title">
              {flow.extensionClearConfirming ? (
                <div
                  id="connection-extension-clear-confirm"
                  className={styles.extensionPanel}
                  data-tone="danger"
                  role="group"
                  tabIndex={-1}
                  aria-labelledby="connection-extension-title"
                  aria-describedby="connection-extension-clear-detail"
                >
                  <div className={styles.extensionPanelCopy}>
                    <h3 id="connection-extension-title" className={styles.extensionTitle}>
                      清空扩展请求配置？
                    </h3>
                    <p id="connection-extension-clear-detail" className={styles.extensionHint}>
                      清空会在下次测试或保存时生效，当前连接的扩展内容将不再使用。
                    </p>
                  </div>
                  <div className={styles.extensionActions}>
                    <Button
                      id="connection-extension-clear-cancel"
                      variant="secondary"
                      className={styles.compactButton}
                      disabled={busy}
                      onClick={() => {
                        focusExtension('clear')
                        flow.cancelExtensionClear()
                      }}
                    >
                      保留扩展
                    </Button>
                    <DangerAction
                      label="确认清空"
                      emphasis="quiet"
                      className={styles.compactButton}
                      disabled={busy}
                      onClick={() => {
                        focusExtension('undo')
                        flow.confirmExtensionClear()
                      }}
                    />
                  </div>
                </div>
              ) : flow.extensionMode === 'clear' ? (
                <div className={styles.extensionPanel} data-tone="pending">
                  <span className={styles.extensionDot} data-tone="pending" aria-hidden="true" />
                  <div className={styles.extensionPanelCopy}>
                    <h3 id="connection-extension-title" className={styles.extensionTitle}>
                      已标记清空
                    </h3>
                    <p className={styles.extensionHint}>
                      测试或保存会使用无扩展配置；保存成功后显示为未配置。
                    </p>
                  </div>
                  <div className={styles.extensionActions}>
                    <Button
                      id="connection-extension-clear-undo"
                      variant="secondary"
                      className={styles.compactButton}
                      disabled={busy}
                      onClick={() => {
                        focusExtension('clear')
                        flow.undoExtensionClear()
                      }}
                    >
                      撤销
                    </Button>
                  </div>
                </div>
              ) : flow.extensionEditorOpen ? (
                <div id="connection-extension-editor" className={styles.extensionEditor}>
                  <div className={styles.extensionTitleRow}>
                    <h3 id="connection-extension-title" className={styles.extensionTitle}>
                      扩展请求配置
                    </h3>
                    <span className={styles.extensionBadge}>可选</span>
                    {flow.hasExtension ? (
                      <span className={styles.extensionBadge} data-tone="configured">
                        已配置
                      </span>
                    ) : null}
                  </div>
                  <p id="connection-extension-purpose" className={styles.extensionHint}>
                    用于供应商要求的特殊请求头、查询参数等；按当前供应商校验，不生效的键会被拒绝。
                  </p>
                  <FormField label="扩展 JSON" htmlFor="extension-json">
                    <TextArea
                      id="extension-json"
                      className={styles.extensionTextarea}
                      value={flow.extensionDraft}
                      onChange={(event) => flow.setExtensionDraft(event.target.value)}
                      rows={6}
                      spellCheck={false}
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      placeholder={'例如：{ "defaultHeaders": { "X-Provider-Header": "..." } }'}
                      aria-describedby="connection-extension-purpose connection-extension-hints"
                    />
                  </FormField>
                  <p id="connection-extension-hints" className={styles.extensionHelp}>
                    {
                      'JSON 对象，最多 8 KiB；可用键：defaultHeaders、defaultQuery、fetchOptions、logLevel。'
                    }
                    <span className={styles.extensionHelpNote}>
                      {flow.hasExtension ? '留空表示保留已配置内容。' : '留空表示不保存扩展配置。'}
                    </span>
                    <span
                      className={styles.extensionHelpNote}
                      data-tone={flow.providerId === 'openai-compatible' ? 'caution' : undefined}
                    >
                      {extensionProviderHint(flow.providerId)}
                    </span>
                  </p>
                  <div className={styles.extensionEditorFoot}>
                    <Button
                      variant="secondary"
                      className={styles.compactButton}
                      disabled={busy}
                      onClick={() => {
                        focusExtension('entry')
                        flow.closeExtensionEditor()
                      }}
                    >
                      {flow.hasExtension ? '取消替换' : '取消填写'}
                    </Button>
                  </div>
                </div>
              ) : flow.hasExtension ? (
                <div className={styles.extensionPanel} data-tone="configured">
                  <span className={styles.extensionDot} aria-hidden="true" />
                  <div className={styles.extensionPanelCopy}>
                    <h3
                      id="connection-extension-title"
                      className={styles.extensionTitle}
                      data-testid="connection-extension-configured"
                    >
                      已配置（内容不回显）
                    </h3>
                    <p className={styles.extensionHint}>
                      当前连接已保存扩展请求配置。替换会整体覆盖，清空会在下次测试或保存时生效。
                    </p>
                  </div>
                  <div className={styles.extensionActions}>
                    <Button
                      id="connection-extension-replace"
                      variant="secondary"
                      className={styles.compactButton}
                      disabled={busy}
                      onClick={() => {
                        focusExtension('editor')
                        flow.openExtensionEditor()
                      }}
                    >
                      替换
                    </Button>
                    <DangerAction
                      id="connection-extension-clear"
                      label="清空"
                      emphasis="quiet"
                      className={styles.compactButton}
                      disabled={busy}
                      onClick={() => {
                        focusExtension('confirm')
                        flow.requestExtensionClear()
                      }}
                    />
                  </div>
                </div>
              ) : (
                <button
                  id="connection-extension-entry"
                  type="button"
                  className={styles.extensionEntry}
                  disabled={busy}
                  onClick={() => {
                    focusExtension('editor')
                    flow.openExtensionEditor()
                  }}
                >
                  <span className={styles.extensionEntryCopy}>
                    <span className={styles.extensionTitleRow}>
                      <span id="connection-extension-title" className={styles.extensionTitle}>
                        扩展请求配置
                      </span>
                      <span className={styles.extensionBadge}>可选</span>
                    </span>
                    <span className={styles.extensionHint}>
                      供应商要求的特殊请求头、查询参数等；通常无需填写。
                    </span>
                  </span>
                  <span className={styles.extensionEntryAction}>
                    <PlusIcon />
                    填写
                  </span>
                </button>
              )}
            </section>
          </form>
        ) : null}
        {flow.state === 'load-error' && flow.status ? (
          <div role="status" aria-atomic="true">
            <StatusPanel
              status={flow.status.kind}
              title={flow.status.title}
              detail={flow.status.detail}
            />
          </div>
        ) : null}
      </Dialog>
      {flow.status ? (
        <Dialog
          open={feedbackOpen}
          title="连接状态"
          size="narrow"
          allowClose
          onClose={() => setFeedbackOpen(false)}
          actions={
            <Button variant="secondary" onClick={() => setFeedbackOpen(false)}>
              关闭
            </Button>
          }
        >
          <StatusPanel
            status={flow.status.kind}
            title={flow.status.title}
            detail={flow.status.detail}
          />
        </Dialog>
      ) : null}
    </>
  )
}
