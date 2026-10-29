FROM node:20-alpine
WORKDIR /app
COPY server.js dashboards.json ./
COPY lib ./lib
COPY public ./public
COPY modules ./modules
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
