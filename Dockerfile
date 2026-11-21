ARG NODE_VERSION=26.13.1

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY .husky/install.mjs .husky/install.mjs
RUN HUSKY=0 npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SQLITE_PATH=/app/data/transit.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules/
COPY --from=build /app/dist ./dist/
RUN install -d -o node -g node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/http/server.js"]
