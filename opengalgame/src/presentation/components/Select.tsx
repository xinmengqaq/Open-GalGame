import * as SelectPrimitive from '@radix-ui/react-select'
import type { ReactElement } from 'react'

import { useDialogElement } from './dialogElement'
import styles from './Select.module.css'

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  id: string
  value: string
  options: SelectOption[]
  disabled?: boolean
  placeholder?: string
  onChange: (value: string) => void
}

/**
 * 统一风格的下拉选择。首字母跳转、Home／End、焦点归还与碰撞定位由 Radix 承担。
 * 选中项文本由调用方给出，不依赖选项是否已挂载，收起状态也能显示当前值。
 */
export function Select({
  id,
  value,
  options,
  disabled,
  placeholder,
  onChange
}: SelectProps): ReactElement {
  const dialogElement = useDialogElement()
  const selected = options.find((option) => option.value === value)
  const display = selected?.label ?? (value || placeholder || '')

  return (
    <SelectPrimitive.Root
      value={value === '' ? undefined : value}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger id={id} className={styles.trigger}>
        <span className={styles.value}>
          <SelectPrimitive.Value placeholder={placeholder}>{display}</SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon asChild>
          <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={dialogElement ?? undefined}>
        <SelectPrimitive.Content className={styles.menu} position="popper" sideOffset={6}>
          <SelectPrimitive.Viewport className={styles.viewport}>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className={styles.option}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
