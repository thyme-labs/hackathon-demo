// End-to-end proof of src/lib/roles + src/lib/chain on an anvil fork of Ethereum Sepolia.
//
//   FORK_RPC_URL=<sepolia rpc url> bun run scripts/fork-test.ts      # spawns anvil itself
//   ANVIL_RPC_URL=http://127.0.0.1:8545 bun run scripts/fork-test.ts  # reuses a running fork
//
// Flow: create Safe 1.4.1 (1/1) -> fund EURC (impersonated Circle faucet sender, fork only) -> install mandate for
// payee1 -> pay -> add payee2 -> pay -> overspend revert (forced on chain) -> unknown payee revert -> remove payee2
// -> 30-day refill -> kill switch (revoke) -> resume -> uninstall. Nothing here touches a real network except
// the optional Safe tx-service probe. The fork URL is never printed. Uses anvil's public default keys only.
import {
  type Address,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  type Hex,
  http,
  keccak256,
  pad,
  toHex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createAgentSigner } from './lib/forkSigner';
import { readBalances, readEurcBalance } from '../src/lib/chain/balances';
import { createSepoliaPublicClient } from '../src/lib/chain/clients';
import {
  buildCreateSafeCall,
  buildExecTransactionCall,
  discoverSafes,
  findPrevModule,
  getSafeInfo,
  isContract,
  isModuleEnabled,
  predictSafeAddress,
  simulateSafeTx,
} from '../src/lib/chain/safe';
import {
  buildPerPayeeConditions,
  canSpend,
  decodeRolesRevert,
  EURC,
  encodeAddPayeeBatch,
  encodeInstallBatch,
  encodeRemovePayeeBatch,
  encodeResumeBatch,
  encodeRevokeBatch,
  encodeUninstallBatch,
  erc20Abi,
  formatEurc,
  MONTH_SECONDS,
  mandateKeys,
  monthlyAllowance,
  parseEurc,
  payeeScope,
  payeesFromConditions,
  remainingFor,
  type SafeTx,
  Status,
  saltFromString,
} from '../src/lib/roles';

// anvil default accounts (public test keys, never used outside a local fork)
const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil #0
const AGENT_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // anvil #1
const MNEMONIC = 'test test test test test test test test test test test junk';
// Circle faucet sender on Sepolia (public address, holds EURC); impersonated on the fork only.
const EURC_FAUCET_SENDER: Address = '0xd844ba11f64d23a7481e24474d2f184e350b9b3d';
const STRANGER: Address = getAddress('0x000000000000000000000000000000000000dEaD');
const FUND_EURC = parseEurc('100000');

type Check = { label: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  checks.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}
function step(title: string): void {
  console.log(`\n== ${title}`);
}

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  throw new Error('anvil did not come up in time');
}

type Fork = { rpcUrl: string; stop: () => void };

async function startFork(): Promise<Fork> {
  const existing = process.env.ANVIL_RPC_URL;
  if (existing) return { rpcUrl: existing, stop: () => undefined };
  const forkUrl = process.env.FORK_RPC_URL;
  if (!forkUrl) throw new Error('set FORK_RPC_URL (a Sepolia RPC endpoint) or ANVIL_RPC_URL');
  const port = process.env.ANVIL_PORT ?? '8646';
  const args = ['anvil', '--fork-url', forkUrl, '--port', port, '--silent', '--chain-id', String(sepolia.id)];
  if (process.env.FORK_BLOCK) args.push('--fork-block-number', process.env.FORK_BLOCK);
  // stdout/stderr are discarded on purpose: anvil echoes the fork endpoint in its banner.
  const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForRpc(rpcUrl, 60_000);
  } catch (err) {
    proc.kill();
    throw err;
  }
  return { rpcUrl, stop: () => proc.kill() };
}

async function main(): Promise<number> {
  const fork = await startFork();
  try {
    return await run(fork.rpcUrl);
  } finally {
    fork.stop();
  }
}

async function run(rpcUrl: string): Promise<number> {
  const pub = createSepoliaPublicClient({ rpcUrl, fallbacks: false });
  const test = createTestClient({ chain: sepolia, mode: 'anvil', transport: http(rpcUrl) });
  const owner = privateKeyToAccount(OWNER_KEY);
  const ownerWallet = createWalletClient({ account: owner, chain: sepolia, transport: http(rpcUrl) });
  const payee1 = mnemonicToAccount(MNEMONIC, { addressIndex: 11 }).address;
  const payee2 = mnemonicToAccount(MNEMONIC, { addressIndex: 12 }).address;

  console.log(`fork chainId=${await pub.getChainId()} block=${await pub.getBlockNumber()}`);
  await test.setBalance({ address: owner.address, value: 10n ** 20n });
  const agent = createAgentSigner({ privateKey: AGENT_KEY, rpcUrl, publicClient: pub });
  await test.setBalance({ address: agent.address, value: 10n ** 19n });

  async function execAsOwner(label: string, safe: Address, tx: SafeTx): Promise<bigint> {
    const sim = await simulateSafeTx(pub, safe, owner.address, tx);
    if (!sim.ok) {
      check(label, false, `simulation: ${sim.revert.name} ${sim.revert.human}`);
      throw new Error(`owner tx would revert: ${label}`);
    }
    const hash = await ownerWallet.writeContract(buildExecTransactionCall(safe, owner.address, tx));
    const receipt = await pub.waitForTransactionReceipt({ hash });
    check(label, receipt.status === 'success', `gas=${receipt.gasUsed}`);
    return receipt.gasUsed;
  }

  // ---- 1. Safe 1.4.1 ----
  step('Safe creation (SafeProxyFactory.createProxyWithNonce)');
  const safeSalt = saltFromString(`fork-test-safe-${Date.now()}`);
  const predictedSafe = await predictSafeAddress(pub, [owner.address], 1n, safeSalt);
  const createCall = buildCreateSafeCall([owner.address], 1n, safeSalt);
  const { result: createdSafe, request: createReq } = await pub.simulateContract({ ...createCall, account: owner });
  const createReceipt = await pub.waitForTransactionReceipt({ hash: await ownerWallet.writeContract(createReq) });
  check('createProxyWithNonce mined', createReceipt.status === 'success', `gas=${createReceipt.gasUsed}`);
  check('predictSafeAddress matches factory result', predictedSafe === createdSafe, predictedSafe);
  const safe = createdSafe;
  const info = await getSafeInfo(pub, safe);
  check(
    'getSafeInfo: deployed, 1/1, owner, no modules',
    info.isDeployed &&
      info.threshold === 1 &&
      info.owners.length === 1 &&
      info.owners[0] === owner.address &&
      info.modules.length === 0,
    `version=${info.version}`,
  );

  // ---- 2. EURC funding ----
  step('Fund the Safe with EURC (impersonated faucet sender)');
  const faucetBalance = await readEurcBalance(pub, EURC_FAUCET_SENDER);
  if (faucetBalance < FUND_EURC) {
    // Fallback: write the FiatToken balance slot directly (balanceAndBlacklistStates mapping, slot 9).
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [EURC_FAUCET_SENDER, 9n]));
    await test.setStorageAt({ address: EURC, index: slot, value: pad(toHex(FUND_EURC * 2n), { size: 32 }) });
  }
  await test.impersonateAccount({ address: EURC_FAUCET_SENDER });
  await test.setBalance({ address: EURC_FAUCET_SENDER, value: 10n ** 18n });
  const faucetWallet = createWalletClient({ account: EURC_FAUCET_SENDER, chain: sepolia, transport: http(rpcUrl) });
  const fundHash = await faucetWallet.writeContract({
    address: EURC,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [safe, FUND_EURC],
  });
  await pub.waitForTransactionReceipt({ hash: fundHash });
  await test.stopImpersonatingAccount({ address: EURC_FAUCET_SENDER });
  const balances = await readBalances(pub, safe);
  check(
    'readBalances (multicall): Safe holds 100000 EURC',
    balances.eurc === FUND_EURC,
    `eurc=${balances.formatted.eurc} eth=${balances.formatted.eth}`,
  );

  // ---- 3. Install the mandate for payee1 ----
  step('Install mandate (one owner tx)');
  const keys = mandateKeys(`fork-${Date.now()}`);
  const p1 = payeeScope(keys.roleKey, payee1);
  const p2 = payeeScope(keys.roleKey, payee2);
  const known = { allowanceKeys: { payee1: p1.allowanceKey, payee2: p2.allowanceKey } };
  const roundTrip = payeesFromConditions(buildPerPayeeConditions([p1, p2]));
  check(
    'conditions round-trip',
    roundTrip.length === 2 && roundTrip[0]?.wallet === p1.wallet && roundTrip[1]?.allowanceKey === p2.allowanceKey,
  );
  const install = encodeInstallBatch({
    safe,
    agent: agent.address,
    roleKey: keys.roleKey,
    rolesSalt: keys.rolesSalt,
    payee: p1,
    allowance: monthlyAllowance(parseEurc('1000')),
  });
  const rolesProxy = install.rolesProxy;
  await execAsOwner(
    'install: deployModule+enableModule+assignRoles+scopeTarget+scopeFunction+setAllowance',
    safe,
    install.safeTx,
  );
  check('Roles proxy deployed at the predicted CREATE2 address', await isContract(pub, rolesProxy), rolesProxy);
  check('module enabled on the Safe', await isModuleEnabled(pub, safe, rolesProxy));
  const b1 = await remainingFor(pub, { rolesProxy, roleKey: keys.roleKey, wallet: payee1 });
  check(
    'remainingFor(payee1) = 1000, limit 1000, full, resets in 30 days',
    b1.isSet &&
      b1.full &&
      b1.remaining === parseEurc('1000') &&
      b1.limit === parseEurc('1000') &&
      b1.nextRefillAt === b1.raw.timestamp + MONTH_SECONDS,
  );

  // ---- 4. Pay ----
  step('Agent pays payee1 300 EURC');
  const pre = await agent.preflightPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee1, amountEurc: parseEurc('300') },
    known,
  );
  check('preflight ok', pre.ok, pre.ok ? `gasEstimate=${pre.gasEstimate}` : pre.revert.human);
  const r1 = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee1, amountEurc: parseEurc('300') },
    { known },
  );
  check('payout confirmed', r1.status === 'confirmed', `gas=${r1.gasUsed} tx=${r1.txHash.slice(0, 12)}`);
  check(
    'ConsumeAllowance decoded: 300 consumed, 700 left',
    r1.consumed.length === 1 &&
      r1.consumed[0]?.consumed === parseEurc('300') &&
      r1.consumed[0]?.newBalance === parseEurc('700'),
  );
  check('payee1 received 300 EURC', (await readEurcBalance(pub, payee1)) === parseEurc('300'));
  const b1b = await remainingFor(pub, { rolesProxy, roleKey: keys.roleKey, wallet: payee1 });
  check(
    'remainingFor(payee1) = 700, not full',
    b1b.remaining === parseEurc('700') && !b1b.full,
    formatEurc(b1b.remaining),
  );
  check(
    'canSpend(700, 800) false / (700, 700) true',
    !canSpend(b1b, parseEurc('800')).ok && canSpend(b1b, parseEurc('700')).ok,
  );

  // ---- 5. Add payee2 ----
  step('Add payee2 (one owner tx), pay payee2');
  const add = encodeAddPayeeBatch({
    rolesProxy,
    roleKey: keys.roleKey,
    allPayees: [p1, p2],
    newPayees: [{ payee: p2, allowance: monthlyAllowance(parseEurc('500')) }],
  });
  await execAsOwner('add payee2: scopeFunction(N=2) + setAllowance(key2)', safe, add.safeTx);
  const [b1c, b2] = await Promise.all([
    remainingFor(pub, { rolesProxy, roleKey: keys.roleKey, wallet: payee1 }),
    remainingFor(pub, { rolesProxy, roleKey: keys.roleKey, wallet: payee2 }),
  ]);
  check('payee1 allowance untouched by re-scope (700)', b1c.remaining === parseEurc('700'));
  check('payee2 allowance = 500', b2.remaining === parseEurc('500'));
  const r2 = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee2, amountEurc: parseEurc('100') },
    { known },
  );
  check('payee2 payout confirmed', r2.status === 'confirmed', `gas=${r2.gasUsed}`);

  // ---- 6. Overspend (forced on chain) ----
  step('Overspend: payee1 800 with 700 left');
  const safeBefore = await readEurcBalance(pub, safe);
  const over = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee1, amountEurc: parseEurc('800') },
    { known },
  );
  check(
    'overspend tx mined as reverted',
    over.status === 'reverted',
    `gas=${over.gasUsed} tx=${over.txHash.slice(0, 12)}`,
  );
  check(
    'revert decoded: ConditionViolation(OrViolation)',
    over.revert?.name === 'ConditionViolation' && over.revert.status === Status.OrViolation,
    over.revert?.human,
  );
  check('no EURC moved', (await readEurcBalance(pub, safe)) === safeBefore);
  const b1d = await remainingFor(pub, { rolesProxy, roleKey: keys.roleKey, wallet: payee1 });
  check('payee1 allowance unchanged by the revert (700)', b1d.remaining === parseEurc('700'));

  // ---- 7. Unknown payee ----
  step('Unknown payee: 1 EURC to a wallet not on the list');
  const unknown = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: STRANGER, amountEurc: parseEurc('1') },
    { known },
  );
  check(
    'unknown payee reverted on chain with OrViolation',
    unknown.status === 'reverted' && unknown.revert?.status === Status.OrViolation,
    unknown.revert?.human,
  );
  const rejected = await agent.preflightPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: STRANGER, amountEurc: parseEurc('1') },
    known,
  );
  check('preflight reports the rejection without sending', !rejected.ok);

  // ---- 8. Remove payee2 ----
  step('Remove payee2');
  const rm = encodeRemovePayeeBatch({
    rolesProxy,
    roleKey: keys.roleKey,
    remainingPayees: [p1],
    removedKeys: [p2.allowanceKey],
  });
  await execAsOwner('remove payee2: scopeFunction([p1]) + setAllowance(key2 -> 0)', safe, rm.safeTx);
  const b2b = await remainingFor(pub, { rolesProxy, roleKey: keys.roleKey, wallet: payee2 });
  check(
    'payee2 budget cleared (isSet=false, limit 0)',
    !b2b.isSet && b2b.remaining === 0n && b2b.limit === 0n && b2b.nextRefillAt === undefined,
  );
  const r3 = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee2, amountEurc: parseEurc('1') },
    { known },
  );
  check('payee2 payout now reverts', r3.status === 'reverted');
  const r4 = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee1, amountEurc: parseEurc('100') },
    { known },
  );
  check('payee1 still paid (600 left)', r4.status === 'confirmed' && r4.consumed[0]?.newBalance === parseEurc('600'));

  // ---- 9. 30-day refill ----
  step('30-day refill (off-chain accrual vs chain)');
  await test.increaseTime({ seconds: Number(MONTH_SECONDS) });
  await test.mine({ blocks: 1 });
  const b1e = await remainingFor(pub, { rolesProxy, roleKey: keys.roleKey, wallet: payee1 });
  check('off-chain accrual says 1000 after 30 days', b1e.remaining === parseEurc('1000'), formatEurc(b1e.remaining));
  const r5 = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee1, amountEurc: parseEurc('950') },
    { known },
  );
  check('chain agrees: 950 paid, 50 left', r5.status === 'confirmed' && r5.consumed[0]?.newBalance === parseEurc('50'));

  // ---- 10. Kill switch, resume, uninstall ----
  step('Kill switch (revoke), resume, uninstall');
  await execAsOwner(
    'revoke: assignRoles(agent, [role], [false])',
    safe,
    encodeRevokeBatch({ rolesProxy, roleKey: keys.roleKey, agent: agent.address }).safeTx,
  );
  const r6 = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee1, amountEurc: parseEurc('1') },
    { known },
  );
  check('after revoke: NoMembership', r6.status === 'reverted' && r6.revert?.name === 'NoMembership', r6.revert?.human);
  await execAsOwner(
    'resume: assignRoles(agent, [role], [true])',
    safe,
    encodeResumeBatch({ rolesProxy, roleKey: keys.roleKey, agent: agent.address }).safeTx,
  );
  const r7 = await agent.sendPayout(
    { rolesProxy, roleKey: keys.roleKey, payee: payee1, amountEurc: parseEurc('1') },
    { known },
  );
  check(
    'after resume: paid again (limits intact, 49 left)',
    r7.status === 'confirmed' && r7.consumed[0]?.newBalance === parseEurc('49'),
  );
  const prev = await findPrevModule(pub, safe, rolesProxy);
  await execAsOwner(
    'uninstall: revoke + disableModule',
    safe,
    encodeUninstallBatch({ safe, rolesProxy, roleKey: keys.roleKey, agent: agent.address, prevModule: prev }).safeTx,
  );
  check('module disabled', !(await isModuleEnabled(pub, safe, rolesProxy)));

  // ---- 11. Decoder vectors (from the research run) ----
  step('Revert decoder vectors');
  const v1 = decodeRolesRevert(
    '0xd0a9bf5800000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000000',
  );
  check('OrViolation', v1.status === 5 && v1.statusName === 'OrViolation');
  const v2 = decodeRolesRevert(
    '0xd0a9bf580000000000000000000000000000000000000000000000000000000000000003095ea7b300000000000000000000000000000000000000000000000000000000',
  );
  check('FunctionNotAllowed with selector', v2.status === 3 && v2.infoMeaning === 'selector 0x095ea7b3');
  const v3 = decodeRolesRevert(
    `0xd0a9bf580000000000000000000000000000000000000000000000000000000000000011${p1.allowanceKey.slice(2)}`,
    known,
  );
  check('AllowanceExceeded names the key', v3.status === 17 && v3.infoMeaning === 'allowance "payee1"');
  check('NoMembership', decodeRolesRevert('0xfd8e9f28').name === 'NoMembership');
  const gs = decodeRolesRevert(
    '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000005475331303400000000000000000000000000000000000000000000000000000000',
  );
  check('Safe GS104', gs.safeCode === 'GS104');

  // ---- 12. Safe tx-service probe (real network, informational) ----
  step('Safe tx-service discovery (real network, informational)');
  const discovered = await discoverSafes(owner.address, { maxPages: 1, timeoutMs: 8_000 });
  console.log(
    `tx-service source=${discovered.source} safes=${discovered.safes.length}${discovered.error ? ` error=${discovered.error}` : ''}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.label}${f.detail ? ` (${f.detail})` : ''}`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const forkUrl = process.env.FORK_RPC_URL;
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(forkUrl ? message.split(forkUrl).join('<fork-rpc>') : message);
    process.exit(1);
  });
