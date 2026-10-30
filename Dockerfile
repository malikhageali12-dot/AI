FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node index.html style.css script.js server.mjs ./

USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
