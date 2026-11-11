import { clsx } from 'clsx'
import type { InputHTMLAttributes, ReactElement, ReactNode, TextareaHTMLAttributes } from 'react'

import styles from './FormField.module.css'

interface FormFieldProps {
  label: string
  optional?: string
  error?: string
  htmlFor: string
  children: ReactNode
}

export function FormField({
  label,
  optional,
  error,
  htmlFor,
  children
}: FormFieldProps): ReactElement {
  return (
    <label className={styles.field} htmlFor={htmlFor}>
      <span>
        {label}
        {optional ? <span className={styles.optional}>{optional}</span> : null}
      </span>
      {children}
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </label>
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
