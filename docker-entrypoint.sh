#!/bin/sh
# Picks the process for WARCON_ROLE: web/all serve the panel (all also runs the worker in-process
# and migrates on start); worker runs the observation/delivery process; migrate applies migrations and exits.
set -e
case "${WARCON_ROLE:-all}" in
  worker)  exec bun ./build/worker.js ;;
  migrate) exec bun ./build/migrate.js ;;
  *)       exec bun ./build/index.js ;;
esac
