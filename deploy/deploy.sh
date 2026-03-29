#!/bin/bash
# Deploy script for Formulo on Lightsail
# Run from /opt/formulo after git pull
#
# Usage: bash deploy/deploy.sh

set -e

echo "=== Pulling latest code ==="
git pull origin main

echo "=== Building and deploying ==="
docker compose up -d --build

echo "=== Checking status ==="
sleep 5
docker compose ps
echo ""
echo "=== Health check ==="
curl -s http://localhost:80/health | python3 -m json.tool || echo "Health check pending, app may still be starting..."
echo ""
echo "Deploy complete."
