# Kalshi band-spread bot

Automated version of the researched strategy (see `../research/STRATEGY.md`):
KNN-filtered hourly band spreads + rule-based daily bands, maker-first
execution, nightly retrain with champion/challenger gating, lockbox skim,
daily stop, and a drawdown kill-switch.

**Ships DISABLED and pointed at the DEMO exchange.** Phase 1 is paper trading.

## Files
- `bot.py` — trading loop (1-minute cycles)
- `retrain.py` — nightly model rebuild from fresh settled ladders
- `common.py` — Kalshi API client (python-native RSA signing) + features
- `config.json` — every knob; re-read live each cycle
- `state/` — runtime truth: `model.json`, `trades.jsonl`, `equity.json`,
  `bot.log`, `killed.json` (present = halted; delete to re-arm)

## Local dry run (your Mac)
```bash
cd bot
python3 -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python3 retrain.py          # builds state/model.json (public data, no key needed)
# put your DEMO key into config.json, set "enabled": true
venv/bin/python3 bot.py
```

## Demo API key
Create a demo account at `demo.kalshi.co`, then Account → API Keys → create,
download the private key file. Put its path + the key id in `config.json`.
Demo money is play money — this is the point of Phase 1.

## Cheapest VPS setup (~$4/month, runs with your computer off)

Recommended: **Hetzner Cloud CX22** (€3.79/mo ≈ $4.10) — reliable, EU/US
regions. Alternatives: DigitalOcean ($4/mo droplet), or Oracle Cloud
"Always Free" ARM (genuinely $0, but signup is finicky).

1. hetzner.com → Cloud → new project → **Add server**: Ubuntu 24.04,
   CX22 (cheapest), add your SSH key. Note the server IP.
2. From your Mac, copy the bot up and log in:
   ```bash
   scp -r ~/Desktop/Projects/kalshi-terminal/bot root@YOUR_IP:/opt/kalshi-bot
   ssh root@YOUR_IP
   ```
3. On the server:
   ```bash
   cd /opt/kalshi-bot
   bash setup.sh                    # installs venv + systemd units + nightly timer
   nano config.json                 # demo api_key_id + private_key_path
   # upload your demo key file too, e.g. from your Mac:
   #   scp ~/Downloads/demo-key.pem root@YOUR_IP:/opt/kalshi-bot/demo-key.pem
   chmod 600 demo-key.pem
   venv/bin/python3 retrain.py      # first model (~5-10 min)
   nano config.json                 # "enabled": true
   systemctl start kalshi-bot
   journalctl -u kalshi-bot -f      # watch it live
   ```
4. It now runs 24/7: auto-restarts on crash or server reboot
   (`Restart=always` + `Persistent=true` timer), retrains nightly at 09:10 UTC.

## Working on it together later
All state is files. From any Claude session on this repo:
"read bot/state/ and tell me how the bot did this week" — then we edit
`config.json` (applies live) or the code (then `systemctl restart kalshi-bot`).
Pull state back to your Mac anytime:
```bash
scp -r root@YOUR_IP:/opt/kalshi-bot/state ~/Desktop/Projects/kalshi-terminal/bot/state-vps
```

## Going live (Phase 2 — later, deliberately)
1. Run demo ≥ 2 weeks; compare `state/trades.jsonl` results to the backtest.
2. Create a SEPARATE prod API key for the bot; fund only what it may risk.
3. In config: `"env": "prod"`, `"i_understand_prod_risks": true`, real key.
   The bot refuses prod without that explicit flag.
4. Keep `max_contracts` at 1–2 for the first live week.

## Safety properties
- Demo by default; prod requires an explicit acknowledgment flag.
- Kill-switch halts ALL trading at 15% drawdown until you delete `killed.json`.
- Daily stop (8%), open-pair cap, contract cap, lockbox ratchet.
- The Kalshi API cannot withdraw funds; worst case is bounded by the account.
- Keys live only on the server (`chmod 600`); use a dedicated key you can revoke.
