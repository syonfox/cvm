FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm i --omit=dev
COPY dist/ ./dist/
COPY scripts/ ./scripts/
COPY spacetime.json spacetime.local.json ./
RUN useradd -m fina && chown -R fina:fina /app
USER fina
EXPOSE 8443
ENV HOST=0.0.0.0 PORT=8443
CMD ["node", "dist/main.js"]
