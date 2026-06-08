FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY ./src ./src
COPY ./index.html ./
COPY ./tailwind.config.js ./
COPY ./postcss.config.js ./
COPY ./tsconfig.json ./
COPY ./tsconfig.node.json ./
COPY ./vite.config.ts ./
COPY ./public ./public

# Bake API/WS URLs into the static build at image build time.
# Pass via docker-compose build.args or --build-arg.
ARG VITE_API_BASE_URL=""
ARG VITE_WS_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_WS_BASE_URL=$VITE_WS_BASE_URL

RUN npm run build

# --- production stage ---
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
