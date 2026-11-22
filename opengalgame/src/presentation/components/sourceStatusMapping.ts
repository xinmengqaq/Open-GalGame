export type SourceStatusCode = 'readable' | 'unreadable' | 'disconnected'

export interface SourceStatusFacts {
  readable: boolean
  disconnected?: boolean
}

export function sourceStatusOf(facts: SourceStatusFacts): SourceStatusCode {
  if (facts.disconnected) return 'disconnected'
  return facts.readable ? 'readable' : 'unreadable'
}
