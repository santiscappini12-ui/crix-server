# Imagen completa (no slim): trae python3/make/g++ para compilar isolated-vm
FROM node:22-bookworm

# Corre como usuario no-root (uid 1000, "node" en esta imagen)
USER node
ENV HOME=/home/node \
    PORT=8080 \
    NODE_ENV=production
WORKDIR /home/node/app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 8080
CMD ["npm", "start"]
