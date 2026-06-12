#!/bin/bash
# Start ACE-Step UI (both frontend and backend)

set -e

# Load environment
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Check ACE-Step path
if [ ! -d "$ACESTEP_PATH" ]; then
    echo "Error: ACESTEP_PATH not set or invalid. Run ./setup.sh first."
    exit 1
fi

echo "Starting ACE-Step UI..."
echo "ACE-Step: $ACESTEP_PATH"
echo ""

FRONTEND_PORT="${FRONTEND_PORT:-3000}"
FRONTEND_HOST="${FRONTEND_HOST:-localhost}"
FRONTEND_PROTOCOL="${FRONTEND_PROTOCOL:-http}"
FRONTEND_ORIGIN="$FRONTEND_PROTOCOL://$FRONTEND_HOST:$FRONTEND_PORT"
PORT="${PORT:-3001}"

# Start backend in background
echo "Starting backend on port $PORT..."
cd server
npm run dev &
BACKEND_PID=$!
cd ..

# Wait for backend
sleep 3

# Start frontend
echo "Starting frontend on port $FRONTEND_PORT..."
npm run dev &
FRONTEND_PID=$!

echo ""
echo "=================================="
echo "  ACE-Step UI Running"
echo "=================================="
echo ""
echo "  Frontend: $FRONTEND_ORIGIN"
echo "  Backend:  http://localhost:$PORT"
echo ""
echo "Press Ctrl+C to stop..."

# Handle shutdown
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM

# Wait for processes
wait
