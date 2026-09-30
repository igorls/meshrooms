#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/meshrooms.wormdb.dev ]; then
    install -o root -g turnserver -m 0640 "$RENEWED_LINEAGE/fullchain.pem" /etc/meshrooms/turn/fullchain.pem
    install -o root -g turnserver -m 0640 "$RENEWED_LINEAGE/privkey.pem" /etc/meshrooms/turn/privkey.pem
    systemctl restart meshrooms-turn.service
fi
