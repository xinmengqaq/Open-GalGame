import { clsx } from 'clsx'
import type { ReactElement } from 'react'

import { Button } from '@presentation/components/Button'
import { ConfirmDialog } from '@presentation/components/ConfirmDialog'
import { DangerAction } from '@presentation/components/DangerAction'
import { FormField, TextArea, TextInput } from '@presentation/components/FormField'
import { PlusIcon } from '@presentation/components/Icons'
import { Select } from '@presentation/components/Select'
import { SettingsHelp } from '@presentation/components/SettingsHelp'
import styles from '../../connection-settings/ConnectionSettingsDialog.module.css'
import { extensionProviderHint } from '../../connection-settings/extensionHints'
import type { SettingsFlow } from '../../connection-settings/useConnectionSettings'

type ExtensionFocusTarget = 'editor' | 'entry' | 'replace' | 'clear' | 'undo'

function ExtensionHelp({
  flow,
  triggerId
}: {
  flow: SettingsFlow
  triggerId?: string
}): ReactElement {
  return (
    <SettingsHelp
      label="扩展请求配置"
      align="end"
      triggerId={triggerId}
      triggerLabel="扩展请求配置说明"
    >
      <p>
        填写供应商要求的请求头或查询参数。可用键：defaultHeaders、defaultQuery、fetchOptions； JSON
        对象最多 8 KiB。对当前协议无效的键会被拒绝。
      </p>
      <p>替换会整体覆盖已配置内容；清空会在下次测试或保存后生效。</p>
      <p>{extensionProviderHint(flow.providerId)}</p>
    </SettingsHelp>
  )
}

export function ConnectionSettingsSection({
  flow,
  onReload
}: {
  flow: SettingsFlow
  onReload: () => void
}): ReactElement {
  const saving = flow.state === 'saving'
  const actionBusy = saving || flow.state === 'testing' || flow.state === 'listing'
  const showForm =
    flow.state === 'editing' ||
    flow.state === 'testing' ||
    flow.state === 'saving' ||
    flow.state === 'listing'
  const modelOptions = flow.models.map((id) => ({ value: id, label: id }))
  if (flow.model && !flow.models.includes(flow.model)) {
    modelOptions.unshift({ value: flow.model, label: flow.model })
  }

  function focusExtension(target: ExtensionFocusTarget): void {
    const id =
      target === 'editor'
        ? 'connection-extension-editor'
        : target === 'entry'
          ? 'connection-extension-entry'
          : target === 'replace'
            ? 'connection-extension-replace'
            : target === 'clear'
              ? 'connection-extension-clear'
              : 'connection-extension-clear-undo'
    window.requestAnimationFrame(() => {
      const node = document.getElementById(id)
      if (node) {
        node.focus({ preventScroll: true })
        return
      }
      document.getElementById('connection-extension-title')?.focus({ preventScroll: true })
    })
  }

  if (flow.loadError) {
    return (
      <div className={styles.statePanel} role="alert">
        <p className={styles.stateTitle}>连接设置无法读取</p>
        <p className={styles.stateText}>{flow.loadError}</p>
        <Button variant="secondary" onClick={onReload}>
          重新读取
        </Button>
      </div>
    )
  }

  if (flow.state === 'loading' || !showForm) {
    return (
      <div
        className={styles.loadingPanel}
        role="status"
        aria-live="polite"
        aria-label="正在读取已保存的连接设置"
      >
        <div className={styles.skeletonRows} aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} className={styles.skeletonRow} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <>
      <form
        className={styles.connectionForm}
        onSubmit={(event) => {
          event.preventDefault()
          void flow.saveSettings()
        }}
      >
        <div className={styles.fieldRow}>
          <FormField
            className={clsx(styles.connectionField, styles.fieldFull)}
            label="协议"
            htmlFor="provider-id"
          >
            <Select
              id="provider-id"
              value={flow.providerId}
              disabled={saving}
              onChange={(value) => flow.setProviderId(value as typeof flow.providerId)}
              options={[
                { value: 'openai-compatible', label: 'OpenAI 兼容' },
                { value: 'anthropic', label: 'Anthropic' }
              ]}
            />
          </FormField>
        </div>

        <div className={styles.fieldRow}>
          <FormField
            className={clsx(styles.connectionField, styles.fieldFull)}
            label="上游地址"
            htmlFor="base-url"
          >
            <TextInput
              id="base-url"
              value={flow.baseUrl}
              disabled={saving}
              onChange={(event) => flow.setBaseUrl(event.target.value)}
            />
          </FormField>
        </div>

        <div className={styles.fieldRow}>
          <FormField
            className={clsx(styles.connectionField, styles.fieldFull)}
            label="模型"
            htmlFor="model-id"
          >
            <div className={styles.modelRow}>
              {flow.models.length > 0 ? (
                <Select
                  id="model-id"
                  value={flow.model}
                  options={modelOptions}
                  disabled={saving}
                  onChange={flow.setModel}
                />
              ) : (
                <TextInput
                  id="model-id"
                  value={flow.model}
                  disabled={saving}
                  onChange={(event) => flow.setModel(event.target.value)}
                />
              )}
              <Button
                variant="secondary"
                disabled={actionBusy}
                onClick={() => void flow.listModels()}
              >
                {flow.state === 'listing' ? '拉取中…' : '拉取列表'}
              </Button>
            </div>
          </FormField>
        </div>

        <div className={styles.fieldRow}>
          <FormField
            className={clsx(styles.connectionField, styles.fieldFull)}
            label="API Key"
            htmlFor="api-key"
          >
            <TextInput
              id="api-key"
              type="password"
              autoComplete="off"
              data-saved={flow.hasApiKey}
              value={flow.apiKey}
              disabled={saving}
              placeholder={flow.hasApiKey ? '已保存密钥，留空保留' : '输入 API Key'}
              onChange={(event) => flow.setApiKey(event.target.value)}
            />
          </FormField>
        </div>

        <div className={styles.fieldRow}>
          <FormField className={styles.connectionField} label="上下文窗口" htmlFor="context-window">
            <TextInput
              id="context-window"
              inputMode="numeric"
              value={flow.contextWindow}
              disabled={saving}
              onChange={(event) => flow.setContextWindow(event.target.value)}
            />
          </FormField>
          <FormField
            className={styles.connectionField}
            label="最大输出 token"
            htmlFor="max-output"
            labelAccessory={
              <SettingsHelp label="最大输出 token" align="end">
                不能超过上下文窗口。供应商可能限制最大输出；被拒绝时请调低此值并重新测试。
              </SettingsHelp>
            }
          >
            <TextInput
              id="max-output"
              inputMode="numeric"
              value={flow.maxOutputTokens}
              disabled={saving}
              onChange={(event) => flow.setMaxOutputTokens(event.target.value)}
            />
          </FormField>
        </div>

        <div className={styles.fieldRow}>
          <FormField
            className={styles.connectionField}
            label="温度"
            optional="与 top-p 二选一"
            htmlFor="temperature"
          >
            <TextInput
              id="temperature"
              value={flow.temperature}
              disabled={saving}
              onChange={(event) => flow.setTemperature(event.target.value)}
            />
          </FormField>
          <FormField className={styles.connectionField} label="top-p" htmlFor="top-p">
            <TextInput
              id="top-p"
              value={flow.topP}
              disabled={saving}
              onChange={(event) => flow.setTopP(event.target.value)}
            />
          </FormField>
        </div>

        <section className={styles.extension} aria-labelledby="connection-extension-title">
          <div className={styles.extensionHead}>
            <div className={styles.extensionTitleRow}>
              <h3 id="connection-extension-title" className={styles.extensionTitle} tabIndex={-1}>
                扩展请求配置
              </h3>
              <span className={styles.extensionBadge}>可选</span>
              {flow.hasExtension ? (
                <span className={styles.extensionBadge} data-tone="configured">
                  已配置
                </span>
              ) : null}
            </div>
            <ExtensionHelp flow={flow} triggerId="connection-extension-help" />
          </div>

          {flow.extensionEditorOpen ? (
            <div id="connection-extension-editor" className={styles.extensionEditor}>
              <FormField
                className={styles.extensionField}
                label="扩展 JSON"
                htmlFor="extension-json"
              >
                <TextArea
                  id="extension-json"
                  className={styles.extensionTextarea}
                  value={flow.extensionDraft}
                  disabled={saving}
                  onChange={(event) => flow.setExtensionDraft(event.target.value)}
                  rows={6}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder={'例如：{ "defaultHeaders": { "X-Provider-Header": "..." } }'}
                  aria-describedby="connection-extension-help"
                />
              </FormField>
              <div className={styles.extensionEditorFoot}>
                <Button
                  variant="secondary"
                  className={styles.compactButton}
                  disabled={saving}
                  onClick={() => {
                    focusExtension(flow.hasExtension ? 'replace' : 'entry')
                    flow.closeExtensionEditor()
                  }}
                >
                  {flow.hasExtension ? '取消替换' : '取消填写'}
                </Button>
              </div>
            </div>
          ) : flow.extensionMode === 'clear' ? (
            <div className={styles.extensionState} data-tone="pending">
              <span className={styles.extensionDot} data-tone="pending" aria-hidden="true" />
              <span className={styles.extensionStateText}>已标记清空，下次保存后生效。</span>
              <div className={styles.extensionActions}>
                <Button
                  id="connection-extension-clear-undo"
                  variant="secondary"
                  className={styles.compactButton}
                  disabled={saving}
                  onClick={() => {
                    focusExtension('clear')
                    flow.undoExtensionClear()
                  }}
                >
                  撤销
                </Button>
              </div>
            </div>
          ) : flow.hasExtension ? (
            <div className={styles.extensionState} data-tone="configured">
              <span className={styles.extensionDot} aria-hidden="true" />
              <span
                className={styles.extensionStateText}
                data-testid="connection-extension-configured"
              >
                已配置（内容不回显）。
              </span>
              <div className={styles.extensionActions}>
                <Button
                  id="connection-extension-replace"
                  variant="secondary"
                  className={styles.compactButton}
                  disabled={saving}
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
                  disabled={saving}
                  onClick={() => {
                    focusExtension('clear')
                    flow.requestExtensionClear()
                  }}
                />
              </div>
            </div>
          ) : (
            <Button
              id="connection-extension-entry"
              variant="secondary"
              className={styles.extensionEntryButton}
              disabled={saving}
              onClick={() => {
                focusExtension('editor')
                flow.openExtensionEditor()
              }}
            >
              <PlusIcon />
              填写扩展请求配置
            </Button>
          )}
        </section>
      </form>

      <ConfirmDialog
        open={flow.extensionClearConfirming}
        title="清空扩展请求配置？"
        message="清空会在下次测试或保存时生效。保存成功后，扩展配置会显示为未配置。"
        confirmLabel="确认清空"
        confirmTone="danger"
        cancelLabel="保留扩展"
        busy={saving}
        onConfirm={() => {
          focusExtension('undo')
          flow.confirmExtensionClear()
        }}
        onCancel={() => {
          focusExtension('clear')
          flow.cancelExtensionClear()
        }}
      />
    </>
  )
}
