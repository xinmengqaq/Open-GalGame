import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, ReactElement } from 'react'

import styles from './Button.module.css'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger'
}

export function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ButtonProps): ReactElement {
  return <button type={type} className={clsx(styles[variant], className)} {...props} />
}
