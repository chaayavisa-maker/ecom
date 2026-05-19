FROM node:20-alpine

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ cairo-dev pango-dev jpeg-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create required directories
RUN mkdir -p logs public

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S dropship -u 1001
RUN chown -R dropship:nodejs /app
USER dropship

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
