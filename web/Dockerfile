FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Development stage
FROM base AS development
EXPOSE 4200
CMD ["npm", "start", "--", "--host", "0.0.0.0"]

# Build stage
FROM base AS build
# Raise Node's heap so the Angular/esbuild production build doesn't crash
# with SIGSEGV/OOM in memory-constrained build environments.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build -- --configuration production

# Production stage
FROM nginx:alpine AS production
COPY --from=build /app/dist/web/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
