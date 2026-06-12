#!/bin/bash
# Manage ACE-Step API, backend, and frontend for CI/remote runners.

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi

ACTION="${1:-status}"
LOG_DIR="$ROOT_DIR/logs"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
PORT="${PORT:-3001}"
ACESTEP_API_URL="${ACESTEP_API_URL:-http://localhost:8001}"
ACESTEP_PATH="${ACESTEP_PATH:-../ACE-Step-1.5}"

mkdir -p "$LOG_DIR"

get_url_port() {
    local url="$1"
    local default_port="$2"
    local without_scheme="${url#*://}"
    local host_port="${without_scheme%%/*}"
    local port="${host_port##*:}"

    if [ "$port" != "$host_port" ] && [ -n "$port" ]; then
        echo "$port"
    else
        echo "$default_port"
    fi
}

ACESTEP_API_PORT="${ACESTEP_API_PORT:-$(get_url_port "$ACESTEP_API_URL" "8001")}"

is_running() {
    local pid_file="$1"
    [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

print_status_line() {
    local name="$1"
    local pid_file="$2"
    local url="$3"

    if is_running "$pid_file"; then
        echo "$name: running (PID $(cat "$pid_file")) $url"
    else
        echo "$name: stopped $url"
    fi
}

status_services() {
    print_status_line "ACE-Step API" "$LOG_DIR/api.pid" "$ACESTEP_API_URL"
    print_status_line "Backend" "$LOG_DIR/backend.pid" "http://localhost:$PORT"
    print_status_line "Frontend" "$LOG_DIR/frontend.pid" "http://localhost:$FRONTEND_PORT"
}

start_api() {
    if is_running "$LOG_DIR/api.pid"; then
        echo "ACE-Step API already running (PID $(cat "$LOG_DIR/api.pid"))."
        return
    fi

    if [ ! -d "$ACESTEP_PATH" ]; then
        echo "Error: ACESTEP_PATH not found: $ACESTEP_PATH"
        exit 1
    fi

    echo "Starting ACE-Step API on port $ACESTEP_API_PORT..."
    (
        cd "$ACESTEP_PATH"
        nohup uv run acestep-api --port "$ACESTEP_API_PORT" > "$LOG_DIR/api.log" 2>&1 &
        echo $! > "$LOG_DIR/api.pid"
    )
}

start_backend() {
    if is_running "$LOG_DIR/backend.pid"; then
        echo "Backend already running (PID $(cat "$LOG_DIR/backend.pid"))."
        return
    fi

    echo "Starting backend on port $PORT..."
    (
        cd "$ROOT_DIR/server"
        nohup npm run dev > "$LOG_DIR/backend.log" 2>&1 &
        echo $! > "$LOG_DIR/backend.pid"
    )
}

start_frontend() {
    if is_running "$LOG_DIR/frontend.pid"; then
        echo "Frontend already running (PID $(cat "$LOG_DIR/frontend.pid"))."
        return
    fi

    echo "Starting frontend on port $FRONTEND_PORT..."
    nohup npm run dev > "$LOG_DIR/frontend.log" 2>&1 &
    echo $! > "$LOG_DIR/frontend.pid"
}

start_services() {
    start_api
    sleep 3
    start_backend
    sleep 2
    start_frontend
    sleep 2
    status_services
}

stop_one() {
    local name="$1"
    local pid_file="$2"

    if is_running "$pid_file"; then
        local pid
        pid="$(cat "$pid_file")"
        echo "Stopping $name (PID $pid)..."
        kill "$pid" 2>/dev/null || true
        sleep 1
        if kill -0 "$pid" 2>/dev/null; then
            echo "$name did not stop gracefully; killing..."
            kill -9 "$pid" 2>/dev/null || true
        fi
    else
        echo "$name is not running."
    fi

    rm -f "$pid_file"
}

stop_services() {
    stop_one "Frontend" "$LOG_DIR/frontend.pid"
    stop_one "Backend" "$LOG_DIR/backend.pid"
    stop_one "ACE-Step API" "$LOG_DIR/api.pid"
}

show_logs() {
    local lines="${2:-80}"

    if ls "$LOG_DIR"/*.log >/dev/null 2>&1; then
        tail -n "$lines" "$LOG_DIR"/*.log
    else
        echo "No logs found in $LOG_DIR."
    fi
}

case "$ACTION" in
    status)
        status_services
        ;;
    start)
        start_services
        ;;
    stop)
        stop_services
        ;;
    restart)
        stop_services
        start_services
        ;;
    logs)
        show_logs "$@"
        ;;
    *)
        echo "Usage: $0 {status|start|stop|restart|logs [lines]}"
        exit 1
        ;;
esac
