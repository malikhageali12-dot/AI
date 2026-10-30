FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json ./
RUN npm install --omit=dev

COPY --chown=node:node index.html style.css script.js server.mjs mathjax-config.js ./

USER node
EXPOSE 4173
CMD ["node", "server.mjs"]

