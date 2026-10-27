FROM python:3.12-slim
WORKDIR /app
COPY backend/ backend/
COPY index.html 0shot.html ./
ENV HOST=0.0.0.0 PORT=3334 PYTHONUNBUFFERED=1
EXPOSE 3334
CMD ["python3", "backend/server.py"]
