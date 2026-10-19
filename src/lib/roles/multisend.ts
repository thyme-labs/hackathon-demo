// MultiSendCallOnly (Safe 1.4.1) packing. Only CALL (operation 0) entries, as the contract enforces.
import { type Address, concatHex, encodeFunctionData, encodePacked, getAddress, type Hex, size } from 'viem';
import { multiSendAbi } from './abi';
import { MULTI_SEND_CALL_ONLY } from './constants';

export type Call = { to: Address; value: bigint; data: Hex };

/** A transaction the Safe owner executes through Safe.execTransaction. operation 1 = delegatecall (MultiSend). */
export type SafeTx = { to: Address; value: bigint; data: Hex; operation: 0 | 1 };

/** operation(1) | to(20) | value(32) | dataLength(32) | data, concatenated for every call. */
export function packMultiSend(calls: readonly Call[]): Hex {
  if (calls.length === 0) throw new Error('multiSend batch is empty');
  return concatHex(
    calls.map((c) =>
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, getAddress(c.to), c.value, BigInt(size(c.data)), c.data],
      ),
    ),
  );
}

export function encodeMultiSend(calls: readonly Call[]): Hex {
  return encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [packMultiSend(calls)] });
}

/** Wrap calls into ONE Safe transaction: delegatecall MultiSendCallOnly. */
export function toMultiSendSafeTx(calls: readonly Call[]): SafeTx {
  return { to: MULTI_SEND_CALL_ONLY, value: 0n, data: encodeMultiSend(calls), operation: 1 };
}
