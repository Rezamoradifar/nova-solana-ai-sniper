FROM python:3.12-slim

WORKDIR /app

# Only copy requirements first so dependency installs are cached across
# rebuilds that only touch application code.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x docker/start.sh

ENV PYTHONUNBUFFERED=1
ENV DB_PATH=/data/memory.sqlite3
VOLUME ["/data"]

EXPOSE 8080

CMD ["./docker/start.sh"]
