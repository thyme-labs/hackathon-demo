// Server functions for the Thyme onboarding (Safe -> Roles profile -> executable -> webhook).
// Handlers dynamic-import the server-only module so this file can be imported from client components.
import { createServerFn } from '@tanstack/react-start'
import type { ConfirmSetupResult, ExecutableResult, PrepareProfileResult, ProfileStatusResult, ThymeOnboardingView } from './dto'

export const getThymeOnboarding = createServerFn({ method: 'GET' }).handler(async (): Promise<ThymeOnboardingView> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { buildOnboardingView } = await import('./thymeOnboarding')
  return buildOnboardingView()
})

export interface PrepareProfileInput {
  safeAddress: string
  ownerAddress: string
}

/** Step 2: Thyme prepares the Roles profile and returns the one transaction the owner sends. */
export const prepareThymeProfile = createServerFn({ method: 'POST' })
  .validator((input: PrepareProfileInput) => input)
  .handler(async ({ data }): Promise<PrepareProfileResult> => {
    const { prepareProfile } = await import('./thymeOnboarding')
    return prepareProfile(data)
  })

export interface ConfirmSetupInput {
  profileId: string
  txHash: string
}

/** Step 4: after the receipt, Thyme verifies the transaction on chain and activates the profile. */
export const confirmThymeSetup = createServerFn({ method: 'POST' })
  .validator((input: ConfirmSetupInput) => input)
  .handler(async ({ data }): Promise<ConfirmSetupResult> => {
    const { confirmSetup } = await import('./thymeOnboarding')
    return confirmSetup(data)
  })

export const refreshThymeProfile = createServerFn({ method: 'POST' })
  .validator((input: { profileId: string }) => input)
  .handler(async ({ data }): Promise<ProfileStatusResult> => {
    const { refreshProfile } = await import('./thymeOnboarding')
    return refreshProfile(data.profileId)
  })

/** Step 5: create the executable + webhook on the active profile. Call again until `ready`. */
export const ensureThymeExecutable = createServerFn({ method: 'POST' }).handler(async (): Promise<ExecutableResult> => {
  const { ensureExecutable } = await import('./thymeOnboarding')
  return ensureExecutable()
})

/** Demo without a wallet: labelled simulation, no Thyme call. */
export const simulateThymeOnboarding = createServerFn({ method: 'POST' })
  .validator((input: { safeAddress?: string | null }) => input)
  .handler(async ({ data }): Promise<ThymeOnboardingView> => {
    const { simulateOnboarding, buildOnboardingView } = await import('./thymeOnboarding')
    simulateOnboarding(data.safeAddress)
    return buildOnboardingView()
  })

export const forgetThymeOnboarding = createServerFn({ method: 'POST' }).handler(async (): Promise<ThymeOnboardingView> => {
  const { forgetOnboarding, buildOnboardingView } = await import('./thymeOnboarding')
  forgetOnboarding()
  return buildOnboardingView()
})
