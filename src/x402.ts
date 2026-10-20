/**
 * x402 payment helper for Thought Receipts.
 *
 * MOCK mode (default, MOCK=true or unset): simulates an EIP-3009 USDC
 * authorization for every reasoning step. Fake signature refs, no real
 * funds move, and the UI labels everything as mock.
 *
 * LIVE mode (MOCK=false): signs a real EIP-3009 TransferWithAuthorization
 * on Base Sepolia USDC with viem, reusing the pattern from our tested
 * x402 buyer. The authorization is signed, not submitted onchain: in x402
 * the seller submits, the buyer only signs. Requires PRIVATE_KEY.
 */
import { randomBytes } from "node:crypto";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import type { Address, Hex } from "viem";

export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const CHAIN_ID = 84532;
export const USDC_DECIMALS = 6;

/** Mock unless explicitly disabled. */
export const MOCK_MODE = process.env.MOCK !== "false";

/** Default price of one reasoning step. */
export const PRICE_PER_STEP_USDC = 0.01;

/** The user funds every thought. */
export const USER_WALLET = "0x1111111111111111111111111111111111111111";

/** Per-agent wallets (mock addresses; replaced by real config in live mode). */
export const AGENT_WALLETS: Record<string, string> = {
  coordinator: "0x2222222222222222222222222222222222222222",
  research: "0x3333333333333333333333333333333333333333",
  compute: "0x4444444444444444444444444444444444444444",
  synthesize: "0x5555555555555555555555555555555555555555",
};

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface StepPayment {
  from: string;
  to: string;
  amountUSDC: string;
  txRef: string;
  mock: boolean;
  note: string;
}

/**
 * Pay for one reasoning step before it runs. Returns the payment record
 * that becomes the receipt's proof of payment.
 */
export async function payForStep(opts: {
  from: string;
  to: string;
  amountUSDC: number;
  memo: string;
}): Promise<StepPayment> {
  const amount = opts.amountUSDC.toFixed(2);

  if (MOCK_MODE) {
    return {
      from: opts.from,
      to: opts.to,
      amountUSDC: amount,
      txRef: `mock-sig-${randomBytes(8).toString("hex")}`,
      mock: true,
      note: "Simulated EIP-3009 authorization. No real USDC moved.",
    };
  }

  const key = process.env.PRIVATE_KEY as Hex | undefined;
  if (!key || key.length < 60) {
    throw new Error("LIVE mode requires a PRIVATE_KEY env var holding a Base Sepolia key.");
  }
  const account = privateKeyToAccount(key);
  const payee = (process.env.PAYEE_ADDRESS as Address | undefined) ?? account.address;
  const nowSec = Math.floor(Date.now() / 1000);
  const value = BigInt(Math.round(opts.amountUSDC * 10 ** USDC_DECIMALS));

  const signature = await signTypedData({
    privateKey: key,
    domain: {
      name: "USDC",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: USDC_BASE_SEPOLIA,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: payee,
      value,
      validAfter: 0n,
      validBefore: BigInt(nowSec + 600),
      nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
    },
  });

  return {
    from: account.address,
    to: payee,
    amountUSDC: amount,
    txRef: signature,
    mock: false,
    note: "Real EIP-3009 authorization signed on Base Sepolia. Signed, not submitted: in x402 the seller submits the authorization onchain.",
  };
}
