import { clsx } from 'clsx'
import type { InputHTMLAttributes, ReactElement, ReactNode, TextareaHTMLAttributes } from 'react'

import styles from './FormField.module.css'

interface FormFieldProps {
  label: string
  optional?: string
  labelAccessory?: ReactNode
  error?: string
  className?: string
  htmlFor: string
  children: ReactNode
}

export function FormField({
  label,
  optional,
  labelAccessory,
  error,
  className,
  htmlFor,
  children
}: FormFieldProps): ReactElement {
  return (
    <div className={clsx(styles.field, className)}>
      <span className={styles.labelRow}>
        <label htmlFor={htmlFor}>
          {label}
          {optional ? <span className={styles.optional}>{optional}</span> : null}
        </label>
        {labelAccessory ? <span className={styles.labelAccessory}>{labelAccessory}</span> : null}
      </span>
      {children}
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

type InputProps = InputHTMLAttributes<HTMLInputElement>

export function TextInput({ className, ...props }: InputProps): ReactElement {
  return <input className={clsx(styles.control, className)} {...props} />
}

type AreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export function TextArea({ className, ...props }: AreaProps): ReactElement {
  return <textarea className={clsx(styles.control, styles.textarea, className)} {...props} />
}
