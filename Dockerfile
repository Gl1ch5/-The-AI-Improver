FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV PORT=3210 HOST=0.0.0.0 DATA_DIR=/app/data NODE_ENV=production
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
EXPOSE 3210
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3210/health || exit 1
CMD ["node", "server/index.js"]
