FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .
COPY auth ./auth
COPY public ./public

ENV PORT=3001
ENV MANIFEST_ROOT=/opt/signalfi/manifests
ENV FIRMWARE_ROOT=/opt/signalfi/files/firmware
ENV AUDIO_ROOT=/opt/signalfi/files/audio
ENV FILES_ROOT=/opt/signalfi/files/general

EXPOSE 3001

CMD ["node", "server.js"]
