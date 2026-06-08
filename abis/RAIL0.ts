// ABI extracted from contracts/src/RAIL0.sol — v0.7.0 (VERSION = "7")
// Keep in sync with the deployed contract.

const paymentComponents = [
  { internalType: "address", name: "payer", type: "address" },
  { internalType: "address", name: "payee", type: "address" },
  { internalType: "address", name: "token", type: "address" },
  { internalType: "uint120", name: "amount", type: "uint120" },
  { internalType: "uint48", name: "authorizationExpiry", type: "uint48" },
  { internalType: "uint48", name: "refundExpiry", type: "uint48" },
  { internalType: "uint16", name: "feeBps", type: "uint16" },
  { internalType: "address", name: "feeReceiver", type: "address" },
] as const;

const paymentStateComponents = [
  { internalType: "bool", name: "exists", type: "bool" },
  { internalType: "uint120", name: "capturableAmount", type: "uint120" },
  { internalType: "uint120", name: "refundableAmount", type: "uint120" },
] as const;

export const RAIL0Abi = [
  // ── Constructor ────────────────────────────────────────────────────────────
  {
    type: "constructor",
    inputs: [{ internalType: "address[]", name: "acceptedTokens", type: "address[]" }],
    stateMutability: "nonpayable",
  },

  // ── Events ─────────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "TokenAccepted",
    inputs: [{ indexed: true, internalType: "address", name: "token", type: "address" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "PaymentAuthorized",
    inputs: [
      { indexed: true, internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "payer", type: "address" },
      { indexed: true, internalType: "address", name: "payee", type: "address" },
      {
        indexed: false,
        internalType: "struct RAIL0.Payment",
        name: "payment",
        type: "tuple",
        components: paymentComponents,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PaymentCharged",
    inputs: [
      { indexed: true, internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "payer", type: "address" },
      { indexed: true, internalType: "address", name: "payee", type: "address" },
      {
        indexed: false,
        internalType: "struct RAIL0.Payment",
        name: "payment",
        type: "tuple",
        components: paymentComponents,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PaymentCaptured",
    inputs: [
      { indexed: true, internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "payer", type: "address" },
      { indexed: true, internalType: "address", name: "payee", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PaymentVoided",
    inputs: [
      { indexed: true, internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "payer", type: "address" },
      { indexed: true, internalType: "address", name: "payee", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PaymentReleased",
    inputs: [
      { indexed: true, internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "payer", type: "address" },
      { indexed: true, internalType: "address", name: "payee", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PaymentRefunded",
    inputs: [
      { indexed: true, internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "payer", type: "address" },
      { indexed: true, internalType: "address", name: "payee", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    anonymous: false,
  },

  // ── Errors ─────────────────────────────────────────────────────────────────
  { type: "error", name: "NotPayee", inputs: [] },
  { type: "error", name: "PaymentAlreadyExists", inputs: [] },
  { type: "error", name: "PaymentNotFound", inputs: [] },
  { type: "error", name: "PaymentMismatch", inputs: [] },
  { type: "error", name: "InvalidAmount", inputs: [] },
  { type: "error", name: "InvalidExpiries", inputs: [] },
  { type: "error", name: "AuthorizationExpired", inputs: [] },
  { type: "error", name: "AuthorizationNotExpired", inputs: [] },
  { type: "error", name: "RefundExpired", inputs: [] },
  { type: "error", name: "FeeBpsTooHigh", inputs: [] },
  { type: "error", name: "ZeroFeeReceiver", inputs: [] },
  { type: "error", name: "FeeReceiverIsParty", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "InvalidCaptureAmount", inputs: [] },
  { type: "error", name: "InvalidRefundAmount", inputs: [] },
  { type: "error", name: "NothingToVoid", inputs: [] },
  { type: "error", name: "NothingToRelease", inputs: [] },
  { type: "error", name: "TokenNotAccepted", inputs: [] },
  { type: "error", name: "DuplicateToken", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "Reentrancy", inputs: [] },

  // ── Write functions ────────────────────────────────────────────────────────
  {
    type: "function",
    name: "authorize",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      {
        internalType: "struct RAIL0.Payment",
        name: "p",
        type: "tuple",
        components: paymentComponents,
      },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "charge",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      {
        internalType: "struct RAIL0.Payment",
        name: "p",
        type: "tuple",
        components: paymentComponents,
      },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "capture",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      {
        internalType: "struct RAIL0.Payment",
        name: "p",
        type: "tuple",
        components: paymentComponents,
      },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "void",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      {
        internalType: "struct RAIL0.Payment",
        name: "p",
        type: "tuple",
        components: paymentComponents,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "release",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      {
        internalType: "struct RAIL0.Payment",
        name: "p",
        type: "tuple",
        components: paymentComponents,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      {
        internalType: "struct RAIL0.Payment",
        name: "p",
        type: "tuple",
        components: paymentComponents,
      },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },

  // ── View functions ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "getPaymentState",
    inputs: [{ internalType: "bytes32", name: "paymentId", type: "bytes32" }],
    outputs: [
      {
        internalType: "struct RAIL0.PaymentState",
        name: "",
        type: "tuple",
        components: paymentStateComponents,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getConfigHash",
    inputs: [{ internalType: "bytes32", name: "paymentId", type: "bytes32" }],
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isAcceptedToken",
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hashPayment",
    inputs: [
      {
        internalType: "struct RAIL0.Payment",
        name: "p",
        type: "tuple",
        components: paymentComponents,
      },
    ],
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "authorizeNonce",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { internalType: "bytes32", name: "configHash", type: "bytes32" },
    ],
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "chargeNonce",
    inputs: [
      { internalType: "bytes32", name: "paymentId", type: "bytes32" },
      { internalType: "bytes32", name: "configHash", type: "bytes32" },
    ],
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    inputs: [],
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "VERSION",
    inputs: [],
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
  },
] as const;
