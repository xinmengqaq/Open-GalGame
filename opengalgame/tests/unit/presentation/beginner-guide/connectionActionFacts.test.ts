import { describe, expect, it } from 'vitest'

import {
  connectionActionFingerprint,
  type ConnectionActionOutcome
} from '@presentation/features/connection-settings/connectionActionFacts'

describe('connection action facts', () => {
  it('returns the config fingerprint only for a confirmed action', () => {
    expect(connectionActionFingerprint('confirmed', 'cfg-test-1')).toBe('cfg-test-1')
  })

  it.each<ConnectionActionOutcome>(['failed', 'cancelled', 'unverified'])(
    'does not confirm a %s action',
    (outcome) => {
      expect(connectionActionFingerprint(outcome, 'cfg-test-1')).toBeNull()
    }
  )
})
