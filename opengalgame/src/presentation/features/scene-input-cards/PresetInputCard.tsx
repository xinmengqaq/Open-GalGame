import { useRef, useState, type ReactElement } from 'react'

import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import type { SessionFieldCard } from '../workbench-session/workbenchSession.types'
import {
  presetDescriptionOf,
  presetLabelOf,
  presetOptionsFor
} from '../workbench-session/webgalPreset'
import { CanvasCardFrame } from './CanvasCardFrame'
import { CardAlertIcon, CardClearIcon } from './InputCardIcons'
import styles from './SceneInputCards.module.css'
import { usePresetErrorMotion, usePresetPreviewMotion } from './useInputCardMotion'

interface PresetInputCardProps {
  card: SessionFieldCard
  selected: boolean
}

/**
 * 动画与特效预设卡。预设状态在头部槽位，具体失败原因留在卡内，
 * 避免同一错误同时出现在通用 Toast 和卡片里。
 */
export function PresetInputCard({ card, selected }: PresetInputCardProps): ReactElement {
  const commands = useWorkbenchCommands()
  const root = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorSeq, setErrorSeq] = useState(0)
  const options = presetOptionsFor(card.kind)
  const selectedName = card.webgalPreset?.name ?? ''
  const kindLabel = card.kind === 'animation' ? '动画' : '特效'
  usePresetPreviewMotion(root, selectedName)
  usePresetErrorMotion(root, error ? errorSeq : 0)

  function showError(text: string): void {
    setError(text)
    setErrorSeq((value) => value + 1)
  }

  async function applyPreset(name: string): Promise<void> {
    if (pending) return
    const option = name.length > 0 ? options.find((item) => item.binding.name === name) : null
    if (name.length > 0 && !option) {
      showError(`应用${kindLabel}预设失败：「${name}」不在当前选项里。`)
      return
    }
    const actionLabel =
      name.length > 0 ? `应用${kindLabel}预设「${option?.label ?? name}」` : `清除${kindLabel}预设`
    setPending(true)
    setError(null)
    const applied = await commands.bindFieldCardPreset(
      card.cardId,
      option ? { ...option.binding } : null
    )
    setPending(false)
    if (applied === 'failed') showError(`${actionLabel}失败，请稍后重试。`)
  }

  const title = card.webgalPreset ? presetLabelOf(card.kind, card.webgalPreset.name) : '请选择预设'
  const description = card.webgalPreset
    ? presetDescriptionOf(card.kind, card.webgalPreset.name)
    : null

  return (
    <div ref={root} className={styles.presetScope}>
      <CanvasCardFrame
        card={card}
        selected={selected}
        status={
          pending ? (
            <span className={styles.presetBadge} data-tone="busy" data-motion="preset-badge">
              正在应用
            </span>
          ) : undefined
        }
      >
        <div className={styles.cardBody}>
          <div className={styles.cardCopy}>
            <h3 className={styles.title} data-empty={!card.webgalPreset}>
              {title}
            </h3>
            {description ? <p className={styles.summary}>{description}</p> : null}
          </div>
          {error ? (
            <p className={styles.presetError} role="alert" data-motion="preset-error">
              <CardAlertIcon />
              <span>{error}</span>
            </p>
          ) : (
            <div
              className={styles.presetEmblem}
              data-preset-emblem
              data-kind={card.kind}
              data-has-preset={Boolean(card.webgalPreset)}
              aria-hidden="true"
            >
              <span className={styles.presetOrbit} />
              <span className={styles.presetOrbitInner} />
              <ContentKindIcon contentKind={card.kind} />
            </div>
          )}
          <div className={`${styles.presetControls} nodrag nopan nowheel`}>
            <label className={styles.selectShell}>
              <span className={styles.visuallyHidden}>
                {card.kind === 'animation' ? '动画预设' : '特效预设'}
              </span>
              <select
                className={styles.presetSelect}
                value={selectedName}
                disabled={pending}
                aria-label={`选择${kindLabel}预设`}
                onChange={(event) => void applyPreset(event.target.value)}
              >
                <option value="">请选择预设</option>
                {options.map((option) => (
                  <option key={option.binding.name} value={option.binding.name}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className={styles.selectChevron} aria-hidden="true" />
            </label>
            {card.webgalPreset ? (
              <button
                type="button"
                className={styles.clearPreset}
                disabled={pending}
                onClick={() => void applyPreset('')}
              >
                <CardClearIcon />
                清除
              </button>
            ) : null}
          </div>
        </div>
      </CanvasCardFrame>
    </div>
  )
}
