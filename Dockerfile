FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    CMYK_ICC_PROFILE=/app/icc/CoatedFOGRA39.icc \
    CMYK_ICC_NAME=CoatedFOGRA39 \
    CMYK_ICC_SHA256=da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77 \
    UV_THREADPOOL_SIZE=4 \
    MALLOC_ARENA_MAX=2
WORKDIR /app
RUN groupadd --system edcbox && useradd --system --gid edcbox --home /app edcbox
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY icc ./icc
USER edcbox
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
