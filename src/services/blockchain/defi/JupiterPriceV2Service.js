import 'reflect-metadata'; // Add this at the top
import { injectable } from 'tsyringe'; // Use a proper DI container
import { TokenProvider } from '../../../providers/token';
import { elizaLogger } from "@ai16z/eliza";
import { Connection, PublicKey } from '@solana/web3.js';
import { WalletProvider } from '../../../providers/wallet';
import { Tool } from "@goat-sdk/core";
import { VersionedTransaction } from "@solana/web3.js";
export class JupiterService {
    baseUrl = "https://quote-api.jup.ag";
    @Tool({
        description: "Get a quote for a swap on the Jupiter DEX",
    })
    async getQuote(parameters) {
        const url = `${this.baseUrl}/v1/quote?${new URLSearchParams(parameters).toString()}`;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        }
        catch (error) {
            throw new Error(`Failed to get quote: ${error}`);
        }
    }
    @Tool({
        description: "Swap an SPL token for another token on the Jupiter DEX",
    })
    async swapTokens(walletClient, parameters) {
        const quoteResponse = await this.getQuote(parameters);
        const swapRequest = {
            userPublicKey: walletClient.getAddress(),
            quoteResponse: quoteResponse,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: "auto",
        };
        const response = await fetch(`${this.baseUrl}/v1/swap`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(swapRequest),
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const { swapTransaction } = await response.json();
        const versionedTransaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
        const instructions = await walletClient.decompileVersionedTransactionToInstructions(versionedTransaction);
        const { hash } = await walletClient.sendTransaction({
            instructions,
            addressLookupTableAddresses: versionedTransaction.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58()),
        });
        return {
            hash,
        };
    }
}
@injectable()
export class JupiterPriceV2Service {
    config;
    tokenProvider;
    cache;
    jupiterService;
    SOLANA_PUBLIC_KEY = new PublicKey(process.env.SOLANA_PUBLIC_KEY || 'C7DjuqwXZ2kZ2D9RMDXv5HjiR7PVkLFJgnX7PKraPDaM');
    static CACHE_TTL = 300; // 5 minutes
    constructor(
    @inject('JupiterPriceServiceConfig')
    config, 
    @inject('TokenProvider')
    tokenProvider, 
    @inject('RedisService')
    cache, 
    @inject('JupiterService')
    jupiterService) {
        this.config = config;
        this.tokenProvider = tokenProvider;
        this.cache = cache;
        this.jupiterService = jupiterService;
        // Initialize providers with validation
        const connection = new Connection(config.rpcConnection?.url || 'https://api.mainnet-beta.solana.com');
        let walletPublicKey;
        try {
            walletPublicKey = config.rpcConnection?.walletPublicKey ?
                new PublicKey(config.rpcConnection.walletPublicKey) :
                new PublicKey(this.SOLANA_PUBLIC_KEY);
        }
        catch (error) {
            elizaLogger.warn('Invalid wallet public key provided, using default');
            walletPublicKey = new PublicKey(this.SOLANA_PUBLIC_KEY);
        }
        const walletProvider = new WalletProvider(connection, walletPublicKey);
        this.tokenProvider = new TokenProvider('', // Will be set per request
        walletProvider, this.cache, { apiKey: process.env.API_KEY || '' });
        this.jupiterService = new JupiterService();
    }
    async getMarketMetrics(symbol) {
        try {
            const cacheKey = `metrics:${symbol}`;
            const cached = await this.cache.get(cacheKey);
            if (typeof cached === 'string') {
                return JSON.parse(cached);
            }
            // Get token data
            const tokenData = await this.tokenProvider.getProcessedTokenData();
            const tradeData = tokenData.tradeData;
            const dexData = tokenData.dexScreenerData;
            const marketMetrics = {
                price: Number(tradeData.price),
                volume24h: Number(tradeData.volume_24h_usd),
                priceChange24h: Number(tradeData.price_change_24h_percent),
                marketCap: dexData.pairs[0]?.marketCap || 0,
                confidenceLevel: this.calculateConfidenceLevel(tradeData, dexData),
                holders: {
                    total: 0,
                    top: []
                },
                onChainActivity: {
                    transactions: 0,
                    swaps: 0,
                    uniqueTraders: 0
                },
                lastUpdate: 0,
                tokenAddress: '',
                topHolders: [],
                volatility: {
                    currentVolatility: 0,
                    averageVolatility: 0,
                    adjustmentFactor: 0
                },
                liquidity: undefined
            };
            await this.cache.set(cacheKey, JSON.stringify(marketMetrics), { expires: JupiterPriceV2Service.CACHE_TTL });
            return marketMetrics;
        }
        catch (error) {
            elizaLogger.error(`Failed to fetch market metrics for ${symbol}:`, error);
            throw error;
        }
    }
    calculateConfidenceLevel(tradeData, dexData) {
        const volume24h = Number(tradeData.volume_24h_usd);
        const liquidity = dexData.pairs[0]?.liquidity?.usd || 0;
        if (volume24h > 100000 && liquidity > 50000)
            return 'high';
        if (volume24h > 10000 && liquidity > 10000)
            return 'medium';
        return 'low';
    }
    // Continuing the JupiterPriceV2Service class...
    async getTokenPrice(symbol) {
        try {
            const cacheKey = `price:${symbol}`;
            const cached = await this.cache.get(cacheKey);
            if (typeof cached === 'string') {
                return JSON.parse(cached);
            }
            // Get token data from TokenProvider
            const tokenData = await this.tokenProvider.getProcessedTokenData();
            const tradeData = tokenData.tradeData;
            const tokenPrice = {
                id: tokenData.tokenCodex.id,
                type: 'token',
                price: tradeData.price.toString(),
                extraInfo: {
                    lastSwappedPrice: {
                        lastJupiterSellAt: tradeData.last_trade_unix_time,
                        lastJupiterSellPrice: tradeData.history_24h_price.toString(),
                        lastJupiterBuyAt: tradeData.last_trade_unix_time,
                        lastJupiterBuyPrice: tradeData.price.toString()
                    },
                    quotedPrice: {
                        buyPrice: tradeData.price.toString(),
                        buyAt: Date.now(),
                        sellPrice: tradeData.history_24h_price.toString(),
                        sellAt: tradeData.last_trade_unix_time
                    },
                    confidenceLevel: this.calculateConfidenceLevel(tradeData, tokenData.dexScreenerData),
                    depth: {
                        buyPriceImpactRatio: {
                            depth: this.calculateDepthImpact(tokenData, 'buy'),
                            timestamp: Date.now()
                        },
                        sellPriceImpactRatio: {
                            depth: this.calculateDepthImpact(tokenData, 'sell'),
                            timestamp: Date.now()
                        }
                    }
                }
            };
            await this.cache.set(cacheKey, JSON.stringify(tokenPrice), { expires: JupiterPriceV2Service.CACHE_TTL });
            return tokenPrice;
        }
        catch (error) {
            elizaLogger.error(`Failed to fetch token price for ${symbol}:`, error);
            throw error;
        }
    }
    async getMarketData(symbol) {
        try {
            const cacheKey = `marketData:${symbol}`;
            const cached = await this.cache.get(cacheKey);
            if (typeof cached === 'string') {
                return JSON.parse(cached);
            }
            const tokenData = await this.tokenProvider.getProcessedTokenData();
            const tradeData = tokenData.tradeData;
            const dexData = tokenData.dexScreenerData;
            const marketData = {
                price: Number(tradeData.price),
                volume24h: Number(tradeData.volume_24h_usd),
                priceChange24h: Number(tradeData.price_change_24h_percent),
                marketCap: dexData.pairs[0]?.marketCap || 0
            };
            await this.cache.set(cacheKey, JSON.stringify(marketData), { expires: JupiterPriceV2Service.CACHE_TTL });
            return marketData;
        }
        catch (error) {
            elizaLogger.error(`Failed to fetch market data for ${symbol}:`, error);
            throw error;
        }
    }
    async getTokenInfo(symbol) {
        try {
            const cacheKey = `tokenInfo:${symbol}`;
            const cached = await this.cache.get(cacheKey);
            if (typeof cached === 'string') {
                return JSON.parse(cached);
            }
            const tokenData = await this.tokenProvider.getProcessedTokenData();
            const tokenCodex = tokenData.tokenCodex;
            if (!tokenCodex || !tokenCodex.address) {
                return null;
            }
            const tokenInfo = {
                id: tokenCodex.id,
                symbol: tokenCodex.symbol,
                name: tokenCodex.name,
                price: Number(tokenData.tradeData.price),
                volume24h: Number(tokenData.tradeData.volume_24h_usd),
                marketCap: tokenData.dexScreenerData.pairs[0]?.marketCap || 0,
                address: tokenCodex.address,
                verified: tokenCodex.blueCheckmark
            };
            await this.cache.set(cacheKey, JSON.stringify(tokenInfo), { expires: JupiterPriceV2Service.CACHE_TTL });
            return tokenInfo;
        }
        catch (error) {
            elizaLogger.error(`Failed to fetch token info for ${symbol}:`, error);
            throw error;
        }
    }
    calculateDepthImpact(tokenData, type) {
        const depths = {
            '10': 0.01, // 1% impact for 10 SOL
            '100': 0.05, // 5% impact for 100 SOL
            '1000': 0.1 // 10% impact for 1000 SOL
        };
        const liquidity = tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0;
        const marketCap = tokenData.dexScreenerData.pairs[0]?.marketCap || 0;
        // Adjust impact based on liquidity and market cap
        const liquidityFactor = liquidity > 100000 ? 0.5 : 1;
        const marketCapFactor = marketCap > 1000000 ? 0.5 : 1;
        const impactMultiplier = liquidityFactor * marketCapFactor;
        return Object.entries(depths).reduce((acc, [depth, impact]) => {
            acc[depth] = impact * impactMultiplier;
            return acc;
        }, {});
    }
    async initializeCache() {
        try {
            await this.cache.connect();
            elizaLogger.info('Jupiter price cache initialized successfully');
        }
        catch (error) {
            elizaLogger.error('Failed to initialize Jupiter price cache:', error);
            throw error;
        }
    }
    async clearCache() {
        try {
            await this.cache.flushAll();
            elizaLogger.info('Jupiter price cache cleared successfully');
        }
        catch (error) {
            elizaLogger.error('Failed to clear Jupiter price cache:', error);
            throw error;
        }
    }
    setTokenProvider(tokenAddress) {
        const connection = new Connection(this.config.rpcConnection?.url || 'https://api.mainnet-beta.solana.com');
        const walletProvider = new WalletProvider(connection, new PublicKey(this.config.rpcConnection?.walletPublicKey || ''));
        this.tokenProvider = new TokenProvider(tokenAddress, walletProvider, this.cache, { apiKey: process.env.API_KEY || '' });
    }
    async getTopMovers(limit = 10) {
        try {
            const cacheKey = `topMovers:${limit}`;
            const cached = await this.cache.get(cacheKey);
            if (cached) {
                return cached;
            }
            const tokenData = await this.tokenProvider.getProcessedTokenData();
            const tradeData = tokenData.tradeData;
            const dexData = tokenData.dexScreenerData;
            const movements = [{
                    id: tokenData.tokenCodex.id,
                    symbol: tokenData.tokenCodex.symbol,
                    address: tokenData.tokenCodex.address,
                    price: Number(tradeData.price),
                    priceChange24h: Number(tradeData.price_change_24h_percent),
                    volume24h: Number(tradeData.volume_24h_usd),
                    currentPrice: Number(tradeData.price),
                    marketCap: dexData.pairs[0]?.marketCap || 0
                }];
            const topMovers = movements
                .sort((a, b) => Math.abs(b.priceChange24h) - Math.abs(a.priceChange24h))
                .slice(0, limit);
            await this.cache.set(cacheKey, topMovers, {
                expires: Date.now() + (5 * 60 * 1000)
            });
            return topMovers;
        }
        catch (error) {
            elizaLogger.error('Failed to fetch top movers:', error);
            throw error;
        }
    }
    async getHighestVolumeTokens(limit = 10) {
        try {
            const cacheKey = `highestVolume:${limit}`;
            const cached = await this.cache.get(cacheKey);
            if (cached) {
                return cached;
            }
            const tokenData = await this.tokenProvider.getProcessedTokenData();
            const tradeData = tokenData.tradeData;
            const dexData = tokenData.dexScreenerData;
            const movements = [{
                    id: tokenData.tokenCodex.id,
                    symbol: tokenData.tokenCodex.symbol,
                    address: tokenData.tokenCodex.address,
                    price: Number(tradeData.price),
                    priceChange24h: Number(tradeData.price_change_24h_percent),
                    volume24h: Number(tradeData.volume_24h_usd),
                    currentPrice: Number(tradeData.price),
                    marketCap: dexData.pairs[0]?.marketCap || 0
                }];
            const highestVolume = movements
                .sort((a, b) => b.volume24h - a.volume24h)
                .slice(0, limit);
            await this.cache.set(cacheKey, highestVolume, {
                expires: Date.now() + (5 * 60 * 1000)
            });
            return highestVolume;
        }
        catch (error) {
            elizaLogger.error('Failed to fetch highest volume tokens:', error);
            throw error;
        }
    }
    setTokenAddress(tokenAddress) {
        this.tokenProvider.setTokenAddress(tokenAddress);
    }
}
export default JupiterPriceV2Service;
