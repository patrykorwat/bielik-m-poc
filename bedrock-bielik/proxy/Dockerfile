FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

EXPOSE 8011
USER node
CMD ["node", "server.js"]
