import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Glyph({
  children,
  ...props
}: IconProps & { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export function SparkIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M12 3.5 13.7 9l5.3 1.8-5.3 1.8L12 18l-1.7-5.4L5 10.8 10.3 9Z" />
      <path d="M18.5 16.5 19 18l1.5.5-1.5.5-.5 1.5-.5-1.5L16.5 18l1.5-.5Z" />
    </Glyph>
  )
}

export function MotionIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M4 15c3.6 0 3.6-6 7.2-6S14.8 15 18.4 15" />
      <path d="M15.5 4.5 19 8l-3.5 3.5" />
      <path d="M4.5 19h15" />
    </Glyph>
  )
}

export function EffectIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </Glyph>
  )
}

export function RecordIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M7.2 7.2 4.5 12l2.7 4.8h4.1L8.6 12l2.7-4.8Z" />
      <path d="M16.8 7.2 19.5 12l-2.7 4.8h-4.1L15.4 12l-2.7-4.8Z" />
    </Glyph>
  )
}

export function EditIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17Z" />
      <path d="m14 7 3 3" />
    </Glyph>
  )
}

export function CopyIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </Glyph>
  )
}

export function TrashIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M5 7h14M9.5 4h5M7 7l.8 12h8.4L17 7" />
      <path d="M10 11v5M14 11v5" />
    </Glyph>
  )
}
