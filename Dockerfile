FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV MUSE_PUBLIC=1 MUSE_HTTPS=1 MUSE_HOST=0.0.0.0 MUSE_PORT=5000 MUSE_DATA=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 5000
CMD ["python", "server.py"]
