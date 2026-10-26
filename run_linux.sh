#!/usr/bin/env bash
# ==============================================================================
# GMTCNT EtherCAT 1-Axis LinuxCNC Commissioning Hub Launch Script (Debian Linux)
# ==============================================================================

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "=== [1/3] Backend Hazırlanıyor (Python FastAPI & LinuxCNC EtherCAT) ==="
cd backend
if [ ! -d "venv" ]; then
    echo "Python sanal ortamı oluşturuluyor..."
    python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r requirements.txt
python3 server.py &
BACKEND_PID=$!
cd ..

echo "=== [2/3] Frontend Hazırlanıyor (React + Vite GMTCNT CNC Theme) ==="
cd frontend
if [ ! -d "node_modules" ]; then
    echo "Frontend bağımlılıkları kuruluyor..."
    npm install
fi
npm run dev &
FRONTEND_PID=$!
cd ..

echo "=== [3/3] Uygulama Başarıyla Başlatıldı! ==="
echo "Tarayıcınızdan http://localhost:5173 adresini açabilirsiniz."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true" EXIT
wait
