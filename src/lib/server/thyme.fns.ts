// Server functions for the Thyme onboarding (Safe -> Roles profile -> executable -> webhook).
// Handlers dynamic-import the server-only module so this file can be imported from client components.
import { createServerFn } from '@tanstack/react-start'
import { tenantMiddleware } from './tenantMiddleware'
import type { ConfirmSetupResult, ExecutableResult, OnboardingStep, PrepareProfileResult, ProfileStatusResult, ThymeOnboardingView } from './dto'

export const getThymeOnboarding = createServerFn({ method: 'GET' }).middleware([tenantMiddleware]).handler(async (): Promise<ThymeOnboardingView> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { buildOnboardingView } = await import('./thymeOnboarding')
  return buildOnboardingView()
})

export interface PrepareProfileInput {
  safeAddress: string
  ownerAddress: string
}

/**
 * The owner Thyme records for a Safe is the wallet of THIS session (proved by Sign-In with Ethereum), never a value the
 * client sends: otherwise any tenant could adopt another tenant's active profile by naming its owner. Demo sessions have
 * no wallet and can only simulate the onboarding.
 */
function sessionOwnerAddress(session: { kind: 'wallet' | 'anon'; address: string | null }, requested: string): string {
  if (session.kind !== 'wallet' || !session.address) {
    throw new Error('Connect a wallet and sign in to enable payroll on a Safe; a demo session can only simulate the onboarding')
  }
  if (requested.toLowerCase() !== session.address.toLowerCase()) {
    throw new Error(`You are signed in as ${session.address}. Sign in with the Safe owner wallet ${requested} to enable payroll with it.`)
  }
  return session.address
}

/** Step 2: Thyme prepares the Roles profile and returns the one transaction the owner sends. */
export const prepareThymeProfile = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: PrepareProfileInput) => input)
  .handler(async ({ data, context }): Promise<PrepareProfileResult> => {
    const { prepareProfile } = await import('./thymeOnboarding')
    const ownerAddress = sessionOwnerAddress(context.session, data.ownerAddress)
    return prepareProfile({ safeAddress: data.safeAddress, ownerAddress })
  })

export interface ConfirmSetupInput {
  profileId: string
  txHash: string
}

/** Step 4: after the receipt, Thyme verifies the transaction on chain and activates the profile. */
export const confirmThymeSetup = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: ConfirmSetupInput) => input)
  .handler(async ({ data }): Promise<ConfirmSetupResult> => {
    const { confirmSetup } = await import('./thymeOnboarding')
    return confirmSetup(data)
  })

/**
 * Step 3: the wallet returned a hash. Stored before the receipt exists so a reload during mining resumes at
 * the confirm step; also used for "I already sent it: here is the hash". Idempotent on the same hash.
 */
export const recordThymeSetupTx = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: ConfirmSetupInput) => input)
  .handler(async ({ data }): Promise<{ txHash: string; step: OnboardingStep }> => {
    const { recordSetupTx } = await import('./thymeOnboarding')
    return recordSetupTx(data)
  })

export const refreshThymeProfile = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { profileId: string }) => input)
  .handler(async ({ data }): Promise<ProfileStatusResult> => {
    const { refreshProfile, readOnboardingState } = await import('./thymeOnboarding')
    // Only the profile this tenant is onboarding: refreshing another profile id would copy its status into this tenant.
    if (readOnboardingState().profileId !== data.profileId) throw new Error('This profile is not the one being onboarded')
    return refreshProfile(data.profileId)
  })

/** Step 5: create the executable + webhook on the active profile. Call again until `ready`. */
export const ensureThymeExecutable = createServerFn({ method: 'POST' }).middleware([tenantMiddleware]).handler(async (): Promise<ExecutableResult> => {
  const { ensureExecutable } = await import('./thymeOnboarding')
  return ensureExecutable()
})

/** Step 4 retry helper: re-read the executable from Thyme; throws a readable error with code and requestId. */
export const resyncThymeExecutable = createServerFn({ method: 'POST' }).middleware([tenantMiddleware]).handler(async (): Promise<ExecutableResult> => {
  const { resyncExecutable } = await import('./thymeOnboarding')
  return resyncExecutable()
})

/** Step 4 reset: forget the executable + webhook only (the profile stays active), so "Create executable" starts over. */
export const resetThymeExecutable = createServerFn({ method: 'POST' }).middleware([tenantMiddleware]).handler(async (): Promise<ThymeOnboardingView> => {
  const { resetExecutable, buildOnboardingView } = await import('./thymeOnboarding')
  resetExecutable()
  return buildOnboardingView()
})

/** Demo without a wallet: labelled simulation, no Thyme call. */
export const simulateThymeOnboarding = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { safeAddress?: string | null }) => input)
  .handler(async ({ data }): Promise<ThymeOnboardingView> => {
    const { simulateOnboarding, buildOnboardingView } = await import('./thymeOnboarding')
    simulateOnboarding(data.safeAddress)
    return buildOnboardingView()
  })

export const forgetThymeOnboarding = createServerFn({ method: 'POST' }).middleware([tenantMiddleware]).handler(async (): Promise<ThymeOnboardingView> => {
  const { forgetOnboarding, buildOnboardingView } = await import('./thymeOnboarding')
  forgetOnboarding()
  return buildOnboardingView()
})
