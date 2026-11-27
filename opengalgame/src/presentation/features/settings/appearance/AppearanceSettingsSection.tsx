import type { CSSProperties, ReactElement } from 'react'

import { Button } from '@presentation/components/Button'
import { Select } from '@presentation/components/Select'
import styles from './AppearanceSettingsSection.module.css'
import {
  BODY_TEXT_SIZE_MAX,
  BODY_TEXT_SIZE_MIN,
  GLASS_OPACITY_MAX,
  GLASS_OPACITY_MIN,
  GLASS_OPACITY_STEP,
  type AppearanceFlow
} from './useAppearanceSettings'
import {
  bodyTextSizeValueText,
  describeBodyTextSize,
  resolveShellFontFamily,
  type AppearanceValues
} from './appearanceTokens'
import { SettingsHelp } from '@presentation/components/SettingsHelp'

const REDUCED_MOTION_OPTIONS: ReadonlyArray<{
  value: AppearanceValues['reducedMotion']
  label: string
}> = [
  { value: 'system', label: '跟随系统' },
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' }
]

function WarningGlyph(): ReactElement {
  return (
    <svg className={styles.warningGlyph} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4.5 3.8 19h16.4Z" />
      <path d="M12 9.5v4.1" />
      <path d="M12 16.4h.01" />
    </svg>
  )
}

export function AppearanceSettingsSection({ flow }: { flow: AppearanceFlow }): ReactElement {
  if (flow.loadState === 'loading') {
    return (
      <div
        className={styles.loadingPanel}
        role="status"
        aria-live="polite"
        aria-label="正在读取外观设置"
      >
        <span className={styles.skeletonPreview} />
        <span className={styles.skeletonRow} />
        <span className={styles.skeletonRow} />
      </div>
    )
  }

  if (flow.loadState === 'error') {
    return (
      <div className={styles.errorBox} role="alert">
        <p className={styles.errorTitle}>无法读取外观设置</p>
        <p className={styles.errorText}>{flow.loadError ?? '请检查设置读取状态后重试。'}</p>
        <div className={styles.errorActions}>
          <Button variant="secondary" onClick={() => void flow.retryLoad()}>
            重新读取
          </Button>
        </div>
      </div>
    )
  }

  const fontOptions = flow.fontPresets.map((preset) => ({
    value: preset.id,
    label: preset.label
  }))
  const selectedPreset = flow.fontPresets.find((preset) => preset.id === flow.draft.fontPresetId)
  const previewFontFamily = resolveShellFontFamily(selectedPreset, flow.selectedFontAvailable)
  const sizeLevel = describeBodyTextSize(flow.draft.bodyTextSize)
  const previewStyle = {
    '--preview-font': previewFontFamily,
    '--preview-size': `${flow.draft.bodyTextSize}px`
  } as CSSProperties

  return (
    <div className={styles.section}>
      <section
        className={styles.preview}
        style={previewStyle}
        data-fallback={flow.selectedFontAvailable ? 'false' : 'true'}
        aria-label="阅读预览"
      >
        <div className={styles.previewWash} aria-hidden="true" />
        <div className={styles.previewHead}>
          <span className={styles.previewLabel}>
            <span className={styles.previewDot} aria-hidden="true" />
            阅读预览
          </span>
          <SettingsHelp label="阅读预览" align="end">
            只影响应用界面中的阅读文字，不改作品内容、预览舞台和画布。
          </SettingsHelp>
        </div>
        <span className={styles.previewQuote} aria-hidden="true">
          “
        </span>
        <p className={styles.previewText}>把心动写成可以选择的故事。</p>
        <p className={styles.previewAside}>下一幕的分叉，由你来写。</p>
        <div className={styles.previewMeta}>
          <span className={styles.previewFontName}>{selectedPreset?.label ?? '系统字体'}</span>
          <span className={styles.previewSizeName}>{sizeLevel.label}</span>
          {flow.selectedFontAvailable ? null : (
            <span className={styles.previewFallback}>系统字体回退</span>
          )}
        </div>
      </section>

      <div className={styles.settingRow}>
        <div className={styles.rowHead}>
          <span className={styles.rowLabelGroup}>
            <label className={styles.label} htmlFor="appearance-font-preset">
              字体
            </label>
            <SettingsHelp label="字体">
              字体随应用内置，切换后按需加载；不会写入作品内容或预览画面。
            </SettingsHelp>
          </span>
          {flow.selectedFontAvailable ? null : (
            <>
              <SettingsHelp
                label="字体状态"
                align="end"
                variant="status"
                tone="warning"
                triggerLabel="未检测到该字体，当前使用系统字体"
                triggerContent={
                  <>
                    <WarningGlyph />
                    系统回退
                  </>
                }
              >
                未检测到该字体，当前使用系统字体。保存时会保留你的选择，不会改成系统字体。
              </SettingsHelp>
              <span className={styles.srOnly} role="status" aria-live="polite">
                未检测到该字体，当前使用系统字体
              </span>
            </>
          )}
        </div>
        <Select
          id="appearance-font-preset"
          value={flow.draft.fontPresetId}
          options={fontOptions}
          disabled={flow.saving}
          onChange={flow.setFontPresetId}
        />
      </div>

      <div className={styles.settingRow}>
        <div className={styles.rowHead}>
          <span className={styles.rowLabelGroup}>
            <label className={styles.label} htmlFor="appearance-body-size-input">
              阅读字号
            </label>
            <SettingsHelp label="阅读字号">
              调整应用内阅读文字的大小；按钮、标签与作品画面不跟随。
            </SettingsHelp>
          </span>
          <span className={styles.levelValue}>{sizeLevel.label}</span>
        </div>
        <div className={styles.sizeRow}>
          <input
            id="appearance-body-size-slider"
            className={styles.range}
            type="range"
            min={BODY_TEXT_SIZE_MIN}
            max={BODY_TEXT_SIZE_MAX}
            step={1}
            value={flow.draft.bodyTextSize}
            disabled={flow.saving}
            aria-label="阅读字号滑块"
            aria-valuetext={bodyTextSizeValueText(flow.draft.bodyTextSize)}
            onChange={(event) => flow.setBodyTextFromSlider(Number(event.target.value))}
          />
          <input
            id="appearance-body-size-input"
            className={styles.numberInput}
            type="text"
            inputMode="numeric"
            value={flow.bodyTextInput}
            disabled={flow.saving}
            aria-invalid={flow.bodyTextError !== null}
            aria-describedby={flow.bodyTextError ? 'appearance-body-size-error' : undefined}
            onChange={(event) => flow.setBodyTextFromInput(event.target.value)}
          />
        </div>
        <div className={styles.rangeMeta}>
          {flow.bodyTextError ? (
            <p id="appearance-body-size-error" className={styles.inlineError} role="alert">
              {flow.bodyTextError}
            </p>
          ) : (
            <>
              <span>更小</span>
              <span>更大</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.rowHead}>
          <span className={styles.rowLabelGroup}>
            <label className={styles.label} htmlFor="appearance-glass-opacity">
              玻璃通透度
            </label>
            <SettingsHelp label="玻璃通透度">
              数值越低越透出背景；开启清晰高对比时会自动提高不透明度。
            </SettingsHelp>
          </span>
          <span className={styles.levelValue}>{flow.draft.glassOpacity}%</span>
        </div>
        <input
          id="appearance-glass-opacity"
          className={styles.range}
          type="range"
          min={GLASS_OPACITY_MIN}
          max={GLASS_OPACITY_MAX}
          step={GLASS_OPACITY_STEP}
          value={flow.draft.glassOpacity}
          disabled={flow.saving}
          aria-valuetext={`${flow.draft.glassOpacity}%`}
          onChange={(event) => flow.setGlassOpacity(Number(event.target.value))}
        />
        <div className={styles.rangeLabels} aria-hidden="true">
          <span>更通透</span>
          <span>更清晰</span>
        </div>
      </div>

      <div className={styles.switchRow}>
        <span className={styles.rowLabelGroup}>
          <span id="appearance-high-contrast-label" className={styles.label}>
            清晰高对比
          </span>
          <SettingsHelp label="清晰高对比">
            提高文字、边框和焦点对比度，并限制玻璃过透；不改变作品画面。
          </SettingsHelp>
        </span>
        <span className={styles.rowTail}>
          <button
            type="button"
            role="switch"
            aria-checked={flow.draft.highContrast}
            aria-labelledby="appearance-high-contrast-label"
            className={styles.switchButton}
            disabled={flow.saving}
            onClick={() => flow.setHighContrast(!flow.draft.highContrast)}
          >
            <span className={styles.switchThumb} aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.rowHead}>
          <span className={styles.rowLabelGroup}>
            <span id="appearance-reduced-motion-label" className={styles.label}>
              减少动态效果
            </span>
            <SettingsHelp label="减少动态效果">
              跟随系统时读取操作系统的减少动态效果偏好；关闭后应用不再主动减少动效。
            </SettingsHelp>
          </span>
        </div>
        <div
          className={styles.segmented}
          role="radiogroup"
          aria-labelledby="appearance-reduced-motion-label"
        >
          {REDUCED_MOTION_OPTIONS.map((option) => {
            const checked = flow.draft.reducedMotion === option.value
            return (
              <label key={option.value} className={styles.segmentOption} data-checked={checked}>
                <input
                  type="radio"
                  name="appearance-reduced-motion"
                  value={option.value}
                  checked={checked}
                  disabled={flow.saving}
                  onChange={() => flow.setReducedMotion(option.value)}
                />
                <span>{option.label}</span>
              </label>
            )
          })}
        </div>
      </div>

      <div className={styles.staticRow}>
        <span className={styles.rowLabelGroup}>
          <span className={styles.label}>主题</span>
          <SettingsHelp label="主题">
            当前只提供默认主题；主题仍是外观设置的一部分，后续新增主题会在这里出现。
          </SettingsHelp>
        </span>
        <span className={styles.themeBadge}>默认主题</span>
      </div>
    </div>
  )
}
