FROM node:26-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ src/

# 非 root 运行；/data 为状态 volume（sqlite + work），/state 为路由/角色状态
RUN useradd -m dwell && mkdir /data /state && chown dwell:dwell /data /state
ENV DWELL_DATA=/data DWELL_STATE=/state
USER dwell

CMD ["node", "src/index.ts"]
