# Multi-stage build for efficiency

# Stage 1: Build
FROM node:25-alpine AS builder

WORKDIR /app

# Copy package files, Yarn config, and bundled Yarn release
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases

# Install ALL dependencies (including devDependencies for build)
RUN yarn install --immutable

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# Build TypeScript
RUN yarn build

# Stage 2: Production
FROM node:25-alpine

WORKDIR /app

# Copy package files and Yarn config
COPY package.json yarn.lock .yarnrc.yml ./

# Create non-root user first
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy Yarn PnP files and cache from builder with correct ownership
COPY --from=builder --chown=nodejs:nodejs /app/.yarn ./.yarn
COPY --from=builder --chown=nodejs:nodejs /app/.pnp.cjs ./
COPY --from=builder --chown=nodejs:nodejs /app/.pnp.loader.mjs ./

# Copy built application from builder with correct ownership
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/migrations ./migrations

USER nodejs

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application with Yarn PnP loader
CMD ["node", "--require", "./.pnp.cjs", "dist/index.js"]
