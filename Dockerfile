FROM node:24-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY design/marca/logo-claro.svg ./design/marca/logo-claro.svg
COPY design/icones ./design/icones
RUN install -d -m 0700 -o node -g node /app/data

ENV NODE_ENV=production DB_PATH=/app/data/fichapro.sqlite
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
