#!/bin/bash
# Lightsail instance setup script for Formulo
# Run this on a fresh Ubuntu 22.04 Lightsail instance (4GB RAM plan)
#
# Usage:
#   1. Create Lightsail instance: Ubuntu 22.04, 4GB RAM ($24/mo)
#   2. SSH in: ssh -i your-key.pem ubuntu@<instance-ip>
#   3. Upload this script and run: bash lightsail-setup.sh

set -e

echo "=== Formulo Lightsail Setup ==="

# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Add ubuntu user to docker group
sudo usermod -aG docker ubuntu

# Install Caddy (reverse proxy with automatic HTTPS)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy

# Create app directory
sudo mkdir -p /opt/formulo
sudo chown ubuntu:ubuntu /opt/formulo

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Clone your repo:  cd /opt/formulo && git clone <your-repo-url> ."
echo "  2. Create .env file: cp .env.example .env && nano .env"
echo "  3. Build and start:  docker compose up -d --build"
echo "  4. Configure Caddy:  sudo nano /etc/caddy/Caddyfile"
echo ""
echo "Caddyfile content (replace formulo.pl with your domain):"
echo ""
echo "  formulo.pl {"
echo "    reverse_proxy localhost:80"
echo "  }"
echo ""
echo "  5. Restart Caddy:    sudo systemctl restart caddy"
echo "  6. Point DNS A record for formulo.pl to this instance IP"
echo ""
