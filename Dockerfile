FROM node:26-slim

# lark-cli（官方 npm 包），供事件消费与消息回复
RUN npm install -g @larksuite/cli

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
