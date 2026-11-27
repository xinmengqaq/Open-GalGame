// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  effectiveReducedMotion,
  prefersReducedMotion,
  subscribeReducedMotion
} from '@presentation/effects/motion'

function stubSystemPreference(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  )
}

afterEach(() => {
  delete document.documentElement.dataset.reducedMotion
  vi.unstubAllGlobals()
})

describe('effective reduced motion', () => {
  it('lets the explicit off setting override a reducing system', () => {
    stubSystemPreference(true)
    document.documentElement.dataset.reducedMotion = 'full'

    expect(effectiveReducedMotion()).toBe('full')
    expect(prefersReducedMotion()).toBe(false)
  })

  it('lets the explicit on setting override a full-motion system', () => {
    stubSystemPreference(false)
    document.documentElement.dataset.reducedMotion = 'reduce'

    expect(effectiveReducedMotion()).toBe('reduce')
    expect(prefersReducedMotion()).toBe(true)
  })

  it('falls back to a reducing system preference before appearance is applied', () => {
    stubSystemPreference(true)
    expect(effectiveReducedMotion()).toBe('reduce')
  })

  it('falls back to a full-motion system preference before appearance is applied', () => {
    stubSystemPreference(false)
    expect(effectiveReducedMotion()).toBe('full')
  })
})

describe('reduced motion subscription', () => {
  it('notifies only when the effective state changes', async () => {
    stubSystemPreference(true)
    const states: boolean[] = []
    const unsubscribe = subscribeReducedMotion((reduced) => states.push(reduced))

    document.documentElement.dataset.reducedMotion = 'full'
    await vi.waitFor(() => expect(states).toEqual([false]))

    document.documentElement.dataset.reducedMotion = 'full'
    await Promise.resolve()
    expect(states).toEqual([false])

    document.documentElement.dataset.reducedMotion = 'reduce'
    await vi.waitFor(() => expect(states).toEqual([false, true]))

    unsubscribe()
  })
})
