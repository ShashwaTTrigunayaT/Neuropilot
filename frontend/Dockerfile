FROM node:20-alpine AS build
WORKDIR /app
# API base URL baked into the bundle; /api is proxied to the api service by nginx
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
COPY package.json .
RUN npm install --no-audit --no-fund
COPY index.html vite.config.js tailwind.config.js postcss.config.js ./
COPY src ./src
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80