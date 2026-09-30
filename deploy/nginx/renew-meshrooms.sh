#!/bin/sh
set -eu
# Certbot deploy hook: reload only after this site's certificate was renewed.
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/meshrooms.wormdb.dev ]; then
    nginx -t
    systemctl reload nginx
fi
