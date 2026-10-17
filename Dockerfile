FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Placeholder for `prisma generate` in this step only. It is not stored as an image ENV.
RUN DATABASE_URL=postgres://user:CHANGE_ME@db:5432/longbox sh -c 'npx prisma generate && npm run build'

ARG LONGBOX_COMMIT=dev
ENV LONGBOX_COMMIT=$LONGBOX_COMMIT
ENV NODE_ENV=production
ENV PORT=3210
ENV HOSTNAME=0.0.0.0

EXPOSE 3210

RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
