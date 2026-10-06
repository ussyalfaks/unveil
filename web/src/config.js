// Fill CONTRACT_ID after deploying (see README). Vite env vars override these.
export const CONFIG = {
  CONTRACT_ID: import.meta.env.VITE_CONTRACT_ID || '',
  RPC_URL: import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org',
  NETWORK_PASSPHRASE: import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  EXPLORER: import.meta.env.VITE_EXPLORER || 'https://stellar.expert/explorer/testnet',
  TOKEN_SYMBOL: import.meta.env.VITE_TOKEN_SYMBOL || 'USDC',
  TOKEN_DECIMALS: 7,
};
