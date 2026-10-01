import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_INVOICE_CONTRACT_ID': '"CDUMMYCONTRACT"',
    'import.meta.env.VITE_SOROBAN_RPC': '"https://dummy-rpc.example.com"',
    'import.meta.env.VITE_NETWORK_PASSPHRASE': '"Test SDF Future Network ; September 2025"',
    'import.meta.env.VITE_TREASURY_CONTRACT_ID': '"CDUMMYTREASURY"',
    'import.meta.env.VITE_COMPLIANCE_CONTRACT_ID': '"CDUMMYCOMPLIANCE"',
    'import.meta.env.VITE_ALLOWED_TOKENS': '"USDC,XLM"',
    'import.meta.env.VITE_API_BASE': '"/api"',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    globals: true,
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
