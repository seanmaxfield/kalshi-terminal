#!/usr/bin/env bash
# One-shot VPS setup (Ubuntu 22.04/24.04). Run as root from the bot/ directory:
#   bash setup.sh
set -euo pipefail
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"

apt-get update -y
apt-get install -y python3-venv python3-pip

python3 -m venv "$BOT_DIR/venv"
"$BOT_DIR/venv/bin/pip" install --quiet -r "$BOT_DIR/requirements.txt"

# systemd: bot service (always running, auto-restart)
cat > /etc/systemd/system/kalshi-bot.service <<EOF
[Unit]
Description=Kalshi band-spread bot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$BOT_DIR
ExecStart=$BOT_DIR/venv/bin/python3 $BOT_DIR/bot.py
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

# systemd: nightly retrain at 09:10 UTC (after daily settles, before US open)
cat > /etc/systemd/system/kalshi-retrain.service <<EOF
[Unit]
Description=Kalshi bot nightly retrain

[Service]
Type=oneshot
WorkingDirectory=$BOT_DIR
ExecStart=$BOT_DIR/venv/bin/python3 $BOT_DIR/retrain.py
EOF

cat > /etc/systemd/system/kalshi-retrain.timer <<EOF
[Unit]
Description=Nightly retrain timer

[Timer]
OnCalendar=*-*-* 09:10:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now kalshi-retrain.timer
systemctl enable kalshi-bot.service

echo ""
echo "Setup complete. Next steps:"
echo "  1. put your DEMO api key id + private key path into $BOT_DIR/config.json"
echo "  2. run the first training:   $BOT_DIR/venv/bin/python3 $BOT_DIR/retrain.py"
echo "  3. set \"enabled\": true in config.json"
echo "  4. start the bot:            systemctl start kalshi-bot"
echo "  5. watch it:                 journalctl -u kalshi-bot -f   (or tail -f $BOT_DIR/state/bot.log)"
