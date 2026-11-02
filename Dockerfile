FROM node:26-slim

# lark-cli（官方 npm 包）的 postinstall 需要 curl 下载二进制，slim 镜像不带
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @larksuite/cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ src/

# 非 root 运行；/data 为状态 volume（sqlite + sessions + 会话工作目录）
RUN useradd -m dwell && mkdir /data && chown dwell:dwell /data
ENV DWELL_DATA=/data
USER dwell

CMD ["node", "src/index.ts"]
