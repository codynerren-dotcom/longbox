#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Add it to the environment before starting Longbox." >&2
  exit 1
fi

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

data_dir="${LONGBOX_DATA_DIR:-${COVERS_DIR:-/data/covers}}"
mkdir -p "$data_dir"
if [ -z "${LONGBOX_SECRET_KEY:-}" ]; then
  key_file="$data_dir/longbox-secret.key"
  if [ ! -s "$key_file" ]; then
    openssl rand -base64 32 | tr -d '\n' > "$key_file"
    chmod 600 "$key_file"
  fi
  LONGBOX_SECRET_KEY="$(tr -d '\n' < "$key_file")"
  export LONGBOX_SECRET_KEY
fi

echo "Seeding the synthetic shelf when that setting is on and the database is empty..."
npx tsx prisma/seed.ts

echo "Starting Longbox on port ${PORT:-3210}"
exec npx next start -p "${PORT:-3210}" -H 0.0.0.0
