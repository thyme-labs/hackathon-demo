// Public, canonical deployments on Ethereum Sepolia. No secrets in this file.
// All addresses verified to have code on Sepolia via eth_getCode (2026-10-19) and
// exercised on an anvil fork by scripts/fork-test.ts.
import type { Address, Hex } from 'viem';

export const SEPOLIA_CHAIN_ID = 11155111;

// Zodiac Roles v2.1.1 (gnosisguild/zodiac-modifier-roles, packages/evm/mastercopies.json)
export const ROLES_MASTERCOPY: Address = '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5';
// Roles v2 MultiSendUnwrapper (only needed if the agent batches transfers through MultiSendCallOnly)
export const MULTISEND_UNWRAPPER: Address = '0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0';
// Zodiac ModuleProxyFactory 1.2.0 (gnosisguild/zodiac, mastercopies/factory/1.2.0)
export const MODULE_PROXY_FACTORY: Address = '0x000000000000aDdB49795b0f9bA5BC298cDda236';

// Safe 1.4.1 canonical deployments (safe-global/safe-deployments)
export const SAFE_PROXY_FACTORY: Address = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
export const SAFE_L2_SINGLETON: Address = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
export const SAFE_SINGLETON: Address = '0x41675C099F32341bf84BFc5382aF534df5C7461a';
export const SAFE_FALLBACK_HANDLER: Address = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
export const MULTI_SEND_CALL_ONLY: Address = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
export const SAFE_SENTINEL_MODULE: Address = '0x0000000000000000000000000000000000000001';

// Circle testnet tokens on Sepolia (FiatToken proxies), both 6 decimals.
export const EURC: Address = '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4';
export const USDC: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const EURC_DECIMALS = 6;
export const USDC_DECIMALS = 6;

// Function selectors
export const SEL_TRANSFER: Hex = '0xa9059cbb'; // transfer(address,uint256)
export const SEL_APPROVE: Hex = '0x095ea7b3'; // approve(address,uint256)
export const SEL_MULTISEND: Hex = '0x8d80ff0a'; // multiSend(bytes)
export const SEL_EXEC_WITH_ROLE: Hex = '0xc6fe8747'; // execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)

// Error selectors (Roles v2.1.1)
export const ERR_CONDITION_VIOLATION: Hex = '0xd0a9bf58'; // ConditionViolation(uint8,bytes32)
export const ERR_NO_MEMBERSHIP: Hex = '0xfd8e9f28'; // NoMembership()
export const ERR_NOT_AUTHORIZED: Hex = '0x4a0bfec1'; // NotAuthorized(address)
export const ERR_MODULE_TX_FAILED: Hex = '0xd27b44a9'; // ModuleTransactionFailed()
export const ERR_MALFORMED_MULTI_ENTRYPOINT: Hex = '0x15e649e9'; // MalformedMultiEntrypoint()
export const ERR_SOLIDITY_ERROR_STRING: Hex = '0x08c379a0'; // Error(string)

// Minimal proxy creation code emitted by ModuleProxyFactory (EIP-1167 variant used by Zodiac):
// prefix ++ mastercopy (20 bytes) ++ suffix.
export const MODULE_PROXY_CREATION_CODE_PREFIX: Hex = '0x602d8060093d393df3363d3d373d3d3d363d73';
export const MODULE_PROXY_CREATION_CODE_SUFFIX: Hex = '0x5af43d82803e903d91602b57fd5bf3';

// Allowance period: 30-day rolling window (not a calendar month).
export const MONTH_SECONDS = 2_592_000n;
export const MAX_UINT128 = (1n << 128n) - 1n;

// Practical and hard limits of the per-payee Or tree (see conditions.ts).
export const MAX_PAYEES_PER_ROLE = 255;
export const RECOMMENDED_MAX_PAYEES = 10;

// Explorer
export const EXPLORER_URL = 'https://sepolia.etherscan.io';
