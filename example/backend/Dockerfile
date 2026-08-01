# Athena Chat backend — conversations + history in front of the graph API.
FROM python:3.12-slim

WORKDIR /app

# Only the deps this service needs (kept separate from the pipeline's requirements).
RUN pip install --no-cache-dir "fastapi>=0.110" "uvicorn[standard]>=0.29" "httpx>=0.27"

# App code + the static chat UI it serves (the whole example/ dir).
COPY example/ /app/example/

ENV ATHENA_GRAPH_API=http://host.docker.internal:8000 \
    ATHENA_CHAT_DB=/data/chat.db \
    ATHENA_CHAT_PORT=8100

VOLUME ["/data"]
EXPOSE 8100

CMD ["uvicorn", "app:app", "--app-dir", "example/backend", "--host", "0.0.0.0", "--port", "8100"]
