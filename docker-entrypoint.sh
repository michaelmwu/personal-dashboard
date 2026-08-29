#!/bin/sh
set -eu

# Coolify mounts named volumes as root-owned. The dashboard keeps all durable
# state in this app-owned volume, then runs the web/API/worker as the Bun user.
install --directory --owner=bun --group=bun --mode=0700 /data /data/home /data/runs
chown --recursive bun:bun /data

exec su -s /bin/sh bun -c 'exec bun scripts/production.mjs'
