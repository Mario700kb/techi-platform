FROM python:3.12-slim

WORKDIR /app

COPY ./requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY ./app /app/app
COPY ./alembic /app/alembic
COPY ./alembic.ini /app/alembic.ini

EXPOSE 8000

# WebSocket keepalive (the uvicorn defaults, made explicit so an upgrade
# cannot change them): a ping every 20 s, closed if unanswered for 20 s. This
# is how an agent channel whose peer lost power or network is noticed within
# 40 s (app/websocket/agent_channel_routes.py; tests/test_status_realtime.py).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--ws-ping-interval", "20", "--ws-ping-timeout", "20"]
