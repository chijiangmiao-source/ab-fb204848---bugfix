FROM node:20-alpine

WORKDIR /app

# 无第三方依赖：仅复制 package.json 用于元信息校验，随后复制全部源码
COPY package.json ./
COPY lib ./lib
COPY src ./src
COPY web ./web
COPY verify ./verify
COPY test ./test

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

USER node

CMD ["node", "src/server.js"]
