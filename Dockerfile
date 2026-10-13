FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV DATABASE_URL=postgresql://longbox:longbox@db:5432/longbox?schema=public
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
ENV PORT=3210
ENV HOSTNAME=0.0.0.0

EXPOSE 3210

RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
