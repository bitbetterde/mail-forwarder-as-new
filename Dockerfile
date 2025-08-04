# Use Alpine-based Node.js image for smaller size
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mailforwarder -u 1001

# Change ownership of the app directory
RUN chown -R mailforwarder:nodejs /app

# Switch to non-root user
USER mailforwarder

# Set environment to production
ENV NODE_ENV=production

# Run the application using the Docker-specific script
CMD ["npm", "run", "start:docker"]
