import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import * as logger from '../../plugin/logger'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

export class TokenRefresher {
  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      // Persist only the updated account instead of all accounts — avoids
      // invalidating the whole AccountCache on every token refresh.
      await this.repository.save(account)
      return { account, shouldContinue: false }
    } catch (e: any) {
      return await this.handleRefreshError(e, account, showToast)
    }
  }

  async forceRefresh(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    const { tokenChanged, routingChanged } = await this.adoptSyncedAccount(account)

    if (tokenChanged && !accessTokenExpired(this.accountManager.toAuthDetails(account), 0)) {
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: recovered newer token from CLI sync')
      return
    }

    try {
      const current =
        tokenChanged || routingChanged ? this.accountManager.toAuthDetails(account) : auth
      const newAuth = await refreshAccessToken(current)
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: token refreshed via OIDC')
    } catch (e: any) {
      logger.warn('Force refresh failed, will retry with current token', {
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  /**
   * Re-sync from kiro-cli and copy the stored record into the in-memory account
   * when its credentials or routing differ. The request loop only reads the
   * in-memory account, so without this a corrected DB row (new token, fixed
   * oidcRegion) is ignored until restart, and later saves of the stale
   * in-memory account can write the old values back.
   */
  private async adoptSyncedAccount(
    account: ManagedAccount
  ): Promise<{ synced?: ManagedAccount; tokenChanged: boolean; routingChanged: boolean }> {
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const synced = accounts.find((a: ManagedAccount) => a.id === account.id)
    if (!synced) return { tokenChanged: false, routingChanged: false }

    const tokenChanged =
      synced.accessToken !== account.accessToken || synced.refreshToken !== account.refreshToken
    const routingChanged =
      synced.region !== account.region ||
      (synced.oidcRegion || undefined) !== (account.oidcRegion || undefined)

    if (tokenChanged || routingChanged) {
      this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced))
      logger.debug('Adopted synced account state', { tokenChanged, routingChanged })
    }
    return { synced, tokenChanged, routingChanged }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })

    const { synced, tokenChanged, routingChanged } = await this.adoptSyncedAccount(account)

    if (
      synced &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(synced),
        this.config.token_expiry_buffer_ms
      )
    ) {
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return { account, shouldContinue: true }
    }

    // The synced access token is expired too, but a different refresh token or
    // OIDC region means the original failure may not apply. Retry once.
    if (tokenChanged || routingChanged) {
      try {
        const newAuth = await refreshAccessToken(this.accountManager.toAuthDetails(account))
        this.accountManager.updateFromAuth(account, newAuth)
        await this.repository.save(account)
        showToast('Credentials recovered after Kiro CLI sync.', 'info')
        return { account, shouldContinue: true }
      } catch (retryError: any) {
        logger.error('Token refresh retry after sync failed', {
          email: account.email,
          code: retryError instanceof KiroTokenRefreshError ? retryError.code : undefined,
          message: retryError instanceof Error ? retryError.message : String(retryError)
        })
        error = retryError
      }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'ExpiredClientException' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403' ||
        error.message.includes('Invalid refresh token provided') ||
        error.message.includes('Invalid grant provided') ||
        error.message.includes('Client is expired'))
    ) {
      this.accountManager.markUnhealthy(account, error.code || error.message)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
