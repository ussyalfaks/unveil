import { MAINNET, TESTNET, type NetworkConfig } from '@unveil/sdk';

export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? '';
export const TOKEN_SYMBOL = process.env.NEXT_PUBLIC_TOKEN_SYMBOL ?? 'XLM';
export const NETWORK: NetworkConfig = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? MAINNET : TESTNET;
export const NETWORK_LABEL = NETWORK === MAINNET ? 'Stellar mainnet' : 'Stellar testnet';
export const EXPLORER = NETWORK.explorerUrl ?? 'https://stellar.expert/explorer/testnet';
