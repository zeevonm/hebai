FROM node:20-slim
WORKDIR /app
COPY server.js .
RUN mkdir -p /app/cache && chown -R node:node /app
USER node
EXPOSE 7860
CMD ["sh", "-c", "echo '[cmd] container shell alive'; node --version; exec node server.js"]
