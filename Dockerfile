FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .nvmrc .env.example ./
COPY src ./src
COPY tests ./tests
COPY public ./public
COPY docs ./docs
COPY postman ./postman
COPY README.md ./README.md
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
