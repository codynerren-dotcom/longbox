#!/bin/sh
set -eu

echo "Applying database migrations..."
attempt=0
until npx prisma migrate deploy; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "Migrations failed after ${attempt} attempts." >&2
    exit 1
  fi
  echo "Database is not ready yet. Retrying..."
  sleep 2
done

if [ "${SEED_ON_EMPTY:-false}" = "true" ]; then
  echo "Seeding the synthetic shelf when the database is empty..."
  npx tsx prisma/seed.ts
fi

echo "Starting Longbox on port ${PORT:-3210}"
exec npx next start -p "${PORT:-3210}" -H 0.0.0.0
