import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig, type Plugin } from 'vite'

/**
 * Wallet SDKs are only ever loaded in the browser (wagmi connectors import them lazily),
 * but the server bundle still tries to resolve them. Stub them server-side.
 */
const BROWSER_ONLY_SDKS = /^(@aave\/|@base-org\/|@coinbase\/|@x402\/|@metamask\/|@gemini-wallet\/|@reown\/|@walletconnect\/|porto$)/

function stubBrowserOnlySdksOnServer(): Plugin {
  const STUB = '\0browser-only-sdk-stub'
  return {
    name: 'thyme:stub-browser-only-sdks',
    enforce: 'pre',
    applyToEnvironment(environment) {
      return environment.name !== 'client'
    },
    resolveId(id) {
      return BROWSER_ONLY_SDKS.test(id) ? STUB : null
    },
    load(id) {
      if (id !== STUB) return null
      // The only names imported statically by wagmi's connector index (gemini, porto) and connectkit (aave); the rest is lazy.
      return {
        code: 'export default {}\nexport const GeminiWalletProvider = class {}\nexport const RpcSchema = {}\nexport const z = {}\nexport const aaveAccountConnector = () => ({})\n',
        moduleSideEffects: false,
      }
    },
  }
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    stubBrowserOnlySdksOnServer(),
    // bun:sqlite is a runtime builtin; keep it out of the server bundle.
    nitro({ rollupConfig: { external: [/^bun:/] } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
