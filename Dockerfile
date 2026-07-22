# syntax=docker/dockerfile:1

FROM nginx:1.27-alpine AS demo
WORKDIR /usr/share/nginx/html
COPY index.html app.js styles.css ./
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

FROM node:22-alpine AS eval
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN mkdir -p results outputs benchmark_data
RUN npm run check:all
CMD ["npm", "run", "check:all"]
