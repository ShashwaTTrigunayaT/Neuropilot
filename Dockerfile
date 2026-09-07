# Stage 1: Build the React Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Python Production Runtime
FROM python:3.11-slim AS runner
ENV PYTHONUNBUFFERED=1 \
    PROJECT_ROOT=/app \
    PORT=8000

WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy backend code, models, and data
COPY backend ./backend
COPY artifacts ./artifacts
COPY data/processed ./data/processed

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 8000

# Start server using Railway's dynamic PORT
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
