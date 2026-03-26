FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .

ENV PORT=3001
ENV MANIFEST_ROOT=/opt/signalfi/manifests

EXPOSE 3001

CMD ["node", "server.js"]
