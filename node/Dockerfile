# Build từ gốc repo (không phải từ trong node/), vì cần COPY cả templates/, muse_bridge.js, lang.html, brains/, extension/:
#   docker build -f node/Dockerfile -t muse-tool-node .
FROM node:20-slim
WORKDIR /app
COPY node/package.json node/package-lock.json* /app/node/
RUN cd /app/node && npm install --omit=dev
COPY . /app
ENV MUSE_PUBLIC=1 MUSE_HTTPS=1 MUSE_HOST=0.0.0.0 MUSE_PORT=5000 MUSE_DATA=/data
VOLUME /data
EXPOSE 5000
WORKDIR /app/node
CMD ["node", "server.js"]
