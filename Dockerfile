FROM node:26-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 生产镜像默认 DWELL_SANDBOX=required：装入 bubblewrap 使探测通过（容器需允许非特权 user namespace）
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src/ src/
COPY templates/ templates/

# 非 root 运行；/data 为状态 volume（sqlite + work），/state 为路由/角色状态
RUN useradd -m dwell && mkdir /data /state && chown dwell:dwell /data /state
ENV NODE_ENV=production DWELL_DATA=/data DWELL_STATE=/state
USER dwell

CMD ["node", "src/index.ts"]
