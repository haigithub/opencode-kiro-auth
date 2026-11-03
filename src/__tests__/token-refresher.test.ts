import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { KiroTokenRefreshError } from '../plugin/errors.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getAccounts: () => [],
    upsertAccount: () => Promise.resolve(),
    deleteAccount: () => Promise.resolve(),
    batchUpsertAccounts: () => Promise.resolve()
  }
}))
mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve(),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: (auth: KiroAuthDetails, bufferMs = 0) =>
    !auth.access || !auth.expires || Date.now() >= auth.expires - bufferMs
}))

// Stand-in for the OIDC endpoint: the refresh token is only valid at the
// region its client was registered in, like the real service.
const REGISTERED_OIDC_REGION = 'ap-southeast-1'
const refreshCalls: KiroAuthDetails[] = []
mock.module('../plugin/token.js', () => ({
  refreshAccessToken: async (auth: KiroAuthDetails): Promise<KiroAuthDetails> => {
    refreshCalls.push({ ...auth })
    if ((auth.oidcRegion || auth.region) !== REGISTERED_OIDC_REGION) {
      throw new KiroTokenRefreshError('Refresh failed: Invalid request', 'invalid_request')
    }
    return { ...auth, access: 'fresh-access', expires: Date.now() + 3600_000 }
  }
}))

const { TokenRefresher } = await import('../core/auth/token-refresher.js')
const { AccountManager } = await import('../plugin/accounts.js')

const config = {
  token_expiry_buffer_ms: 120_000,
  auto_sync_kiro_cli: true,
  account_selection_strategy: 'sticky' as const
}

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    oidcRegion: 'us-east-1',
    refreshToken: 'refresh',
    accessToken: 'expired-access',
    expiresAt: Date.now() - 1000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

function makeRepo(dbRow: ManagedAccount | undefined) {
  return {
    invalidateCache: () => {},
    findAll: async () => (dbRow ? [{ ...dbRow }] : []),
    save: async () => {},
    batchSave: async () => {}
  } as any
}

const noToast = () => {}

beforeEach(() => {
  refreshCalls.length = 0
})

describe('TokenRefresher adopts synced account state', () => {
  test('refresh failure retries with the OIDC region corrected by CLI sync', async () => {
    // In memory: stale routing from an older plugin version. DB: corrected by sync,
    // but the CLI token is just as expired.
    const memory = makeAccount()
    const manager = new AccountManager([memory])
    const refresher = new TokenRefresher(
      config,
      manager,
      async () => {},
      makeRepo(makeAccount({ oidcRegion: 'ap-southeast-1' }))
    )

    const result = await refresher.refreshIfNeeded(memory, manager.toAuthDetails(memory), noToast)

    expect(refreshCalls.map((a) => a.oidcRegion)).toEqual(['us-east-1', 'ap-southeast-1'])
    expect(result.shouldContinue).toBe(true)
    expect(memory.oidcRegion).toBe('ap-southeast-1')
    expect(memory.accessToken).toBe('fresh-access')
    expect(memory.isHealthy).toBe(true)
  })

  test('fresh CLI token from sync is copied into the in-memory account', async () => {
    const memory = makeAccount({ oidcRegion: 'ap-southeast-1', refreshToken: 'rotated-away' })
    const manager = new AccountManager([memory])
    const dbRow = makeAccount({
      oidcRegion: 'ap-southeast-1',
      refreshToken: 'cli-refresh',
      accessToken: 'cli-access',
      expiresAt: Date.now() + 3600_000
    })
    // Route the first refresh to the wrong region so it fails.
    const refresher = new TokenRefresher(config, manager, async () => {}, makeRepo(dbRow))
    const auth = { ...manager.toAuthDetails(memory), oidcRegion: 'us-east-1' as const }

    const result = await refresher.refreshIfNeeded(memory, auth, noToast)

    expect(result.shouldContinue).toBe(true)
    expect(result.account).toBe(memory)
    expect(memory.accessToken).toBe('cli-access')
    expect(memory.refreshToken).toBe('cli-refresh')
    expect(refreshCalls).toHaveLength(1)
  })

  test('no retry when sync brings nothing new', async () => {
    const memory = makeAccount()
    const manager = new AccountManager([memory])
    const refresher = new TokenRefresher(config, manager, async () => {}, makeRepo(memory))

    await expect(
      refresher.refreshIfNeeded(memory, manager.toAuthDetails(memory), noToast)
    ).rejects.toThrow('Invalid request')
    expect(refreshCalls).toHaveLength(1)
    expect(memory.oidcRegion).toBe('us-east-1')
  })

  test('forceRefresh refreshes against the corrected OIDC region', async () => {
    const memory = makeAccount({ accessToken: 'bearer-rejected', expiresAt: Date.now() + 600_000 })
    const manager = new AccountManager([memory])
    const dbRow = { ...memory, oidcRegion: 'ap-southeast-1' as const }
    const refresher = new TokenRefresher(config, manager, async () => {}, makeRepo(dbRow))

    await refresher.forceRefresh(memory, manager.toAuthDetails(memory))

    expect(refreshCalls.map((a) => a.oidcRegion)).toEqual(['ap-southeast-1'])
    expect(memory.oidcRegion).toBe('ap-southeast-1')
    expect(memory.accessToken).toBe('fresh-access')
  })
})
