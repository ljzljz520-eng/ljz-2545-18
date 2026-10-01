# 街区章节服务层镜像
FROM node:20-alpine

WORKDIR /app

# 先装依赖（pg 为 optionalDependencies，安装失败不阻塞内存模式）
COPY package.json ./
RUN npm install --omit=dev || true

# 拷贝源码与 SQL
COPY src/ ./src/
COPY sql/ ./sql/

ENV PORT=3000
EXPOSE 3000

# DATABASE_URL 存在时使用 PostgreSQL，否则内存模式（含种子数据）
CMD ["node", "src/server.js"]
