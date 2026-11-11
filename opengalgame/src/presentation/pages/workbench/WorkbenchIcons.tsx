import { clsx } from 'clsx'
import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Glyph({
  className,
  children,
  ...props
}: IconProps & { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      className={clsx(className)}
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

export function SearchIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Glyph>
  )
}

export function RefreshIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M20 12a8 8 0 1 1-2.2-5.5" />
      <path d="M20 5v5h-5" />
    </Glyph>
  )
}

export function InspectIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4M11 8v3l2 2" />
    </Glyph>
  )
}

export function UndoIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M8 8H4v4" />
      <path d="M5 12a8 8 0 1 0 2-5.5" />
    </Glyph>
  )
}

export function RedoIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M16 8h4v4" />
      <path d="M19 12a8 8 0 1 1-2-5.5" />
    </Glyph>
  )
}

export function FitIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
    </Glyph>
  )
}

export function MinusIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M6 12h12" />
    </Glyph>
  )
}

export function BackIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M15 6 9 12l6 6" />
    </Glyph>
  )
}

export function PlayIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m8 6 11 6-11 6Z" />
    </Glyph>
  )
}

export function PauseIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M8 6h3v12H8ZM13 6h3v12h-3Z" />
    </Glyph>
  )
}

export function SaveIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M5 4h11l3 3v13H5Z" />
      <path d="M8 4v6h8V4M8 15h8v5H8Z" />
    </Glyph>
  )
}

export function HistoryIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 5v4h4" />
      <path d="M12 8v4.5l3 1.8" />
    </Glyph>
  )
}

export function ClearIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M5 7h14M9 7V5h6v2" />
      <path d="M7 7v12h10V7" />
      <path d="M10 11v5M14 11v5" />
    </Glyph>
  )
}

export function RestoreIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 5v4h4" />
      <path d="M12 8v4h4" />
    </Glyph>
  )
}

export function ChevronDownIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m6 9 6 6 6-6" />
    </Glyph>
  )
}

export function MoreIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

export function ImportIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M12 4v11" />
      <path d="m8 11 4 4 4-4" />
      <path d="M5 20h14" />
    </Glyph>
  )
}
