import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cssInjectedByJs from 'vite-plugin-css-injected-by-js'

// Builds a self-contained IIFE bundle at wallet-dist/wallet.js
// Any HTML page can include it with: <script src="/wallet-dist/wallet.js"></script>
export default defineConfig({
  plugins: [
    react(),
    cssInjectedByJs(), // injects CSS (including RainbowKit's) into the JS bundle
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: 'src/wallet/main.tsx',
      name: 'OrlixWallet',
      formats: ['iife'],
      fileName: () => 'wallet.js',
    },
    outDir: 'wallet-dist',
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Inline all dynamic imports so the bundle is a single file
        inlineDynamicImports: true,
      },
    },
  },
})
