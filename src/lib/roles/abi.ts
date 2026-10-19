// Human-readable ABIs (viem parseAbi) for Safe 1.4.1, Zodiac Roles v2.1.1, ModuleProxyFactory 1.2.0 and ERC-20.
// Roles shapes verified against the verified Sepolia mastercopy ABI (Roles v2.1.1).
import { parseAbi } from 'viem';

export const safeAbi = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function isOwner(address owner) view returns (bool)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
  'event ExecutionFromModuleSuccess(address indexed module)',
  'event ExecutionFromModuleFailure(address indexed module)',
  'event EnabledModule(address indexed module)',
  'event DisabledModule(address indexed module)',
]);

export const safeProxyFactoryAbi = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function proxyCreationCode() pure returns (bytes)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]);

export const moduleProxyFactoryAbi = parseAbi([
  'function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)',
  'error TakenAddress(address address_)',
  'error ZeroAddress(address target)',
  'error TargetHasNoCode(address target)',
  'error FailedInitialization()',
]);

export const rolesAbi = parseAbi([
  'function setUp(bytes initParams)',
  'function owner() view returns (address)',
  'function avatar() view returns (address)',
  'function target() view returns (address)',
  'function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
  'function scopeTarget(bytes32 roleKey, address targetAddress)',
  'function revokeTarget(bytes32 roleKey, address targetAddress)',
  'function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)',
  'function revokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)',
  'function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)',
  'function setTransactionUnwrapper(address to, bytes4 selector, address adapter)',
  'function allowances(bytes32 key) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)',
  'function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool success)',
  'function execTransactionWithRoleReturnData(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool success, bytes returnData)',
  'event ConsumeAllowance(bytes32 allowanceKey, uint128 consumed, uint128 newBalance)',
  'event SetAllowance(bytes32 allowanceKey, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)',
  'event AssignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
  'event ScopeTarget(bytes32 roleKey, address targetAddress)',
  'event RevokeTarget(bytes32 roleKey, address targetAddress)',
  'event ScopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)',
  'error ConditionViolation(uint8 status, bytes32 info)',
  'error NoMembership()',
  'error NotAuthorized(address sender)',
  'error ModuleTransactionFailed()',
  'error MalformedMultiEntrypoint()',
  'error FunctionSignatureTooShort()',
  'error CalldataOutOfBounds()',
  'error ArraysDifferentLength()',
  'error AlreadyEnabledModule(address module)',
  'error AlreadyDisabledModule(address module)',
  'error InvalidModule(address module)',
  'error InvalidPageSize()',
  'error HashAlreadyConsumed(bytes32)',
  'error OwnableUnauthorizedAccount(address account)',
  'error OwnableInvalidOwner(address owner)',
  'error SetupModulesAlreadyCalled()',
  'error InvalidInitialization()',
  'error NotInitializing()',
  // Integrity.sol (scopeFunction validation) errors bubble up from the mastercopy.
  'error UnsuitableRootNode()',
  'error NotBFS()',
  'error UnsuitableParameterType(uint256 index)',
  'error UnsuitableCompValue(uint256 index)',
  'error UnsupportedOperator(uint256 index)',
  'error UnsuitableParent(uint256 index)',
  'error UnsuitableChildCount(uint256 index)',
  'error UnsuitableChildTypeTree(uint256 index)',
]);

export const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable']);

export const multicall3Abi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)']);
