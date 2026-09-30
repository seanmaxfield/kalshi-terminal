# Kalshi Terminal

Bloomberg-style terminal for Kalshi: browses every open event and submarket,
live orderbooks, and trade execution through your own Kalshi API key.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. Market data works immediately with no credentials.

## Enable trading

1. Create an API key at kalshi.com → Account → API Keys (download the private key file).
2. `cp .env.example .env` and fill in `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY_PATH`.
3. Restart `npm run dev`. The header shows your balance; the trade ticket goes live.

Set `KALSHI_ENV=demo` to paper-trade against `demo-api.kalshi.co` first.

## Architecture

- `server/index.mjs` — Express proxy on :8787. Forwards `/api/*` to Kalshi
  trade-api/v2 and signs requests (RSA-PSS) when a key is configured. Your
  private key never leaves the machine.
- `src/` — React (Vite) frontend. Loads all open events with nested markets
  progressively, groups by category, search + expandable submarket tables,
  orderbook polling (5s), limit/market order ticket with confirm step,
  positions and open-order management.
