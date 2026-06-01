import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ALLOWED_RPC_ORIGINS = [
  "https://soroban-testnet.stellar.org",
  "https://soroban-mainnet.stellar.org",
  "https://soroban-testnet-backup.stellar.org",
  "https://soroban-mainnet-backup.stellar.org",
].join(" ");

// unsafe-inline / unsafe-eval are required by Vite's dev and preview servers.
// For production hosting platforms (Vercel, Netlify, Caddy, nginx) replace
// these with a nonce-based policy and set headers at the edge instead.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${ALLOWED_RPC_ORIGINS} wss://relay.walletconnect.com`,
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
  },
  server: {
    headers: SECURITY_HEADERS,
  },
  preview: {
    headers: SECURITY_HEADERS,
  },
});
