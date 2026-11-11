import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Glyph({ children, ...props }: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export function CardArrowIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M5 12h13M13 7l5 5-5 5" />
    </Glyph>
  )
}

export function CardAlertIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M12 4 21 20H3Z" />
      <path d="M12 9.5v5M12 17.2v.3" />
    </Glyph>
  )
}

export function CardClearIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Glyph>
  )
}

export function CardEditIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m14.5 5.5 4 4L8 20H4v-4Z" />
      <path d="m12.5 7.5 4 4" />
    </Glyph>
  )
}

export function CardMediaOffIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h9A1.5 1.5 0 0 1 16 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 16.5Z" />
      <path d="m16 10 4-2.5v9L16 14M4 4l16 16" />
    </Glyph>
  )
}
