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
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export function CardQuestionIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M9.7 9.4a2.4 2.4 0 1 1 3.4 2.2c-.7.35-1.1.9-1.1 1.7v.4M12 16.9v.2" />
    </Glyph>
  )
}
