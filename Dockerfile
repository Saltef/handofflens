# syntax=docker/dockerfile:1

FROM nginx:1.27-alpine AS demo
WORKDIR /usr/share/nginx/html
COPY index.html app.js styles.css ./
EXPOSE 80

FROM node:22-alpine AS eval
WORKDIR /app
COPY package.json ./
COPY app.js ./app.js
COPY prompts ./prompts
COPY eval ./eval
COPY scripts ./scripts
COPY docs ./docs
COPY README.md MODEL_CARD.md .env.example .gitignore .dockerignore Dockerfile docker-compose.yml ./
RUN npm run check
CMD ["npm", "run", "check"]
