import { Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { agentWallet } from './wallet';
import logger from './logger';
import { Token, ChainId } from '@lifi/sdk';


// Constants
const JUPITER_API = {
  TOKENS: 'https://tokens.jup.ag/tokens?tags=verified',
  TOKEN_BY_MINT: 'https://tokens.jup.ag/token', 
  TRADABLE_TOKENS: 'https://tokens.jup.ag/tokens_with_markets',
  PRICE: 'https://api.jup.ag/price/v2',
  QUOTE: 'https://quote-api.jup.ag/v6'
};

const TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  SOL: 'So11111111111111111111111111111111111111112',
  ELONA: '8hVzPgFopqEQmNNoghr5WbPY1LEjW8GzgbLRwuwHpump'
} as const;

// Types
interface TokenInfo {
  extensions: {
    coingeckoId: string;
  };
  daily_volume: number;
  symbol: string;
  name: string;
  price: number;
}

interface SwapInfo {
  ammKey: string;
  label: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  feeAmount: string;
  feeMint: string;
}

interface RoutePlan {
  swapInfo: SwapInfo;
  percent: number;
}

interface SwapQuote {
  slippageBps: number;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  marketInfos: any[];
  swapMode: string;
  otherAmountThreshold: string;
  routePlan: RoutePlan[];
  contextSlot?: number;
  timeTaken?: number;
}

interface SwapResult {
  status: 'success' | 'error' | 'pending_confirmation';
  signature?: string;
  message?: string;
  quote?: SwapQuote;
}

interface TokenMetadata {
  decimals: number;
  logoURI: string | undefined;
  name: any;
  price: any;
  liquidity: any;
  coingeckoData: any;
  coingeckoId: string;
  dailyVolume: number;
  symbol: string; // Add this line
}

/**
 * Get token information from Jupiter
 */
export async function getTokenInfo(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    const response = await fetch(`${JUPITER_API.TOKEN_BY_MINT}/${mintAddress}`);
    
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json() as TokenInfo;
    
    return {
      coingeckoData: null, // or fetch actual coingecko data if needed
      coingeckoId: data.extensions.coingeckoId,
      dailyVolume: data.daily_volume,
      symbol: data.symbol,
      name: data.name,
      price: data.price,
      liquidity: null, // You might want to fetch this from another source
      decimals: 9, // Default to 9 decimals for Solana tokens
      logoURI: undefined
    };
  } catch (error) {
    logger.error('Error fetching Jupiter token info:', error);
    throw error;
  }
}

/**
 * Get swap quote from Jupiter
 */
export async function getSwapQuote(
  amountInSol: number,
  outputMint: string = TOKENS.USDC
): Promise<SwapQuote | null> {
  try {
    // Adjust slippage based on token
    const slippageBps = outputMint === TOKENS.ELONA ? 1000 : 50;
    const inputAmount = (amountInSol * LAMPORTS_PER_SOL).toString();
    
    // Prepare query parameters
    const queryParams = new URLSearchParams({
      inputMint: TOKENS.SOL,
      outputMint,
      amount: inputAmount,
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: (outputMint === TOKENS.ELONA).toString(),
      asLegacyTransaction: 'false'
    });

    // Get quote
    const response = await fetch(`${JUPITER_API.QUOTE}/quote?${queryParams}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Jupiter quote error:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
        params: { inputMint: TOKENS.SOL, outputMint, amount: amountInSol, slippageBps }
      });
      return null;
    }

    return await response.json();
  } catch (error) {
    logger.error('Error getting swap quote:', error);
    return null;
  }
}

/**
 * Execute swap transaction
 */
export async function swapSolToToken(
  amountInSol: number,
  outputMint: string = TOKENS.USDC
): Promise<SwapResult> {
  try {
    // Validate input amount
    if (!validateSwapAmount(amountInSol, outputMint)) {
      return { 
        status: 'error', 
        message: 'Invalid swap amount'
      };
    }

    // Get quote
    const quote = await getSwapQuote(amountInSol, outputMint);
    if (!quote) {
      return { status: 'error', message: 'Failed to get quote' };
    }

    // Check wallet balance
    const walletInfo = await agentWallet.getBalance();
    if (!walletInfo || walletInfo.balance < amountInSol) {
      return { 
        status: 'error', 
        message: 'Insufficient balance', 
        quote 
      };
    }

    // Log swap details
    logSwapDetails(quote, amountInSol, outputMint);

    // Execute swap
    const transaction = await prepareSwapTransaction(quote, walletInfo.address);
    if (!transaction) {
      return { status: 'error', message: 'Failed to prepare transaction', quote };
    }

    // Sign and send transaction
    const signature = await agentWallet.signAndSendTransaction(transaction);
    return { status: 'success', signature, quote };

  } catch (error) {
    logger.error('Swap error:', error);
    return { 
      status: 'error', 
      message: error instanceof Error ? error.message : 'Transaction failed'
    };
  }
}

/**
 * Helper function to validate swap amount
 */
function validateSwapAmount(amount: number, outputMint: string): boolean {
  if (amount <= 0) return false;
  if (outputMint === TOKENS.ELONA && amount < 0.01) return false;
  if (amount > 1000) return false; // Max swap amount
  return true;
}

/**
 * Helper function to get token decimals
 */
function getTokenDecimals(mint: string): number {
  switch (mint) {
    case TOKENS.USDC:
      return 6;
    case TOKENS.ELONA:
    case TOKENS.SOL:
      return 9;
    default:
      return 9;
  }
}

/**
 * Helper function to log swap details
 */
function logSwapDetails(quote: SwapQuote, amountInSol: number, outputMint: string): void {
  const outputDecimals = 10 ** getTokenDecimals(outputMint);
  const outputAmount = parseInt(quote.outAmount) / outputDecimals;

  logger.info('Swap Quote:', {
    inputAmount: `${amountInSol} SOL`,
    outputAmount: `${outputAmount.toFixed(6)} ${getTokenSymbol(outputMint)}`,
    priceImpact: `${parseFloat(quote.priceImpactPct).toFixed(2)}%`,
    route: quote.routePlan.map(r => r.swapInfo.label).join(' → ')
  });
}

/**
 * Helper function to get token symbol
 */
function getTokenSymbol(mint: string): string {
  switch (mint) {
    case TOKENS.USDC:
      return 'USDC';
    case TOKENS.ELONA:
      return 'ELONA';
    case TOKENS.SOL:
      return 'SOL';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Helper function to prepare swap transaction
 */
async function prepareSwapTransaction(
  quote: SwapQuote, 
  userPublicKey: string
): Promise<VersionedTransaction | null> {
  try {
    const response = await fetch(`${JUPITER_API.QUOTE}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapUnwrapSOL: true,
        computeUnitPriceMicroLamports: 'auto',
        asLegacyTransaction: false
      })
    });

    if (!response.ok) {
      logger.error('Swap API error:', await response.text());
      return null;
    }

    const { swapTransaction } = await response.json();
    const transactionBuffer = Buffer.from(swapTransaction, 'base64');
    return VersionedTransaction.deserialize(transactionBuffer);

  } catch (error) {
    logger.error('Error preparing swap transaction:', error);
    return null;
  }
}

/**
 * Fetch additional tokens from Jupiter
 */
export async function fetchJupiterTokens(): Promise<Token[]> {
  try {
    const response = await fetch(JUPITER_API.TOKENS);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return Object.values(data).map((token: any) => ({
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      logoURI: token.logoURI,
      priceUSD: token.price || '0',
      name: token.name || token.symbol,
      chainId: ChainId.SOL
    }));
  } catch (error) {
    logger.error('Error fetching Jupiter tokens:', error);
    return [];
  }
}

/**
 * Fetch token information
 */
export async function fetchTokenInfo(tokenMint: string): Promise<string> {
  try {
    const tokenInfo = await getTokenInfo(tokenMint);
    if (!tokenInfo) {
      return `Token information for ${tokenMint} not found.`;
    }
    return `Token: ${tokenMint}
Coingecko ID: ${tokenInfo.coingeckoId}
Daily Volume: ${tokenInfo.dailyVolume}`;
  } catch (error) {
    logger.error('Error fetching token info:', error);
    return 'Unable to fetch token information at the moment.';
  }
}

/**
 * Execute token swap
 */
export async function executeSwap(fromToken: string, toToken: string, amountInSol: number, outputMint: string): Promise<string> {
  try {
    const swapResult = await swapSolToToken(amountInSol, outputMint);
    if (swapResult.status === 'success') {
      return `Swap successful! Transaction signature: ${swapResult.signature}`;
    } else {
      return `Swap failed: ${swapResult.message}`;
    }
  } catch (error) {
    logger.error('Error executing swap:', error);
    return 'Unable to execute swap at the moment.';
  }
}

/**
 * Get Jupiter swap details
 */
export async function getJupiterInfo(amountInSol: number): Promise<string> {
  try {
    const quote = await getSwapQuote(amountInSol);
    if (!quote) {
      return "No quote available for these parameters.";
    }
    
    const inAmount = Number(quote.inAmount) / LAMPORTS_PER_SOL;
    const outAmount = Number(quote.outAmount) / Math.pow(10, 6); // USDC decimals
    
    return `Jupiter Swap Details:
Input: ${inAmount.toFixed(4)} SOL
Output: ${outAmount.toFixed(2)} USDC
Price Impact: ${quote.priceImpactPct}%
Slippage: ${quote.slippageBps / 100}%`;
  } catch (error) {
    logger.error('Failed to fetch Jupiter quote:', error);
    return "Failed to fetch Jupiter quote.";
  }
}

/**
 * Execute Jupiter swap
 */
export async function executeJupiterSwap(amountInSol: number, outputMint: string): Promise<string> {
  try {
    const result = await swapSolToToken(amountInSol, outputMint);
    
    if (result.status === 'success') {
      return `Swap Executed:
Amount: ${amountInSol} SOL
Signature: ${result.signature}`;
    } else {
      return `Swap Failed: ${result.message}`;
    }
  } catch (error) {
    logger.error('Failed to execute swap:', error);
    return "Failed to execute swap.";
  }
}

// Export types
export type { 
  TokenInfo, 
  SwapQuote,
  SwapResult,
  TokenMetadata
};