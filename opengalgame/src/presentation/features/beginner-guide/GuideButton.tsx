import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, ReactElement } from 'react'

import { Button } from '../../components/Button'
import styles from './GuideButton.module.css'

interface GuideButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
}

/**
 * 教程自己的 workbench 按钮皮肤：把默认、悬停、按下、禁用和键盘焦点
 * 收在一处，邀请、浮层和弹窗后续都从这枚按钮取样式，不逐页堆选择器。
 */
export function GuideButton({
  variant = 'secondary',
  className,
  ...props
}: GuideButtonProps): ReactElement {
  return (
    <Button
      variant={variant === 'primary' ? 'primary' : 'secondary'}
      className={clsx(styles.button, styles[variant], className)}
      {...props}
    />
  )
}
