#!/bin/bash

# Setup Boot Script for Piso Wifi
# Run this as root

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit 1
fi

echo "🔧 Setting up Piso Wifi Auto-Boot..."

# Get Project Directory
PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
echo "Project Directory: $PROJECT_DIR"

# Find Node Binary
NODE_BIN=$(which node)
if [ -z "$NODE_BIN" ]; then
    # Try common locations if not in PATH
    if [ -f "/usr/bin/node" ]; then
        NODE_BIN="/usr/bin/node"
    elif [ -f "/usr/local/bin/node" ]; then
        NODE_BIN="/usr/local/bin/node"
    else
        echo "❌ Error: Node.js binary not found. Please ensure Node.js is installed."
        exit 1
    fi
fi
echo "Node Binary: $NODE_BIN"
$NODE_BIN -v

# Ensure scripts are executable
echo "🔐 Setting permissions..."
chmod +x "$PROJECT_DIR/src/scripts/"*.sh

# Generate Service File
TEMPLATE_FILE="$PROJECT_DIR/pisowifi.service.template"
SERVICE_FILE="$PROJECT_DIR/pisowifi.service"
TARGET_FILE="/etc/systemd/system/pisowifi.service"

if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "❌ Error: Template file $TEMPLATE_FILE not found."
    exit 1
fi

echo "📝 Generating service file..."
sed -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
    -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    "$TEMPLATE_FILE" > "$SERVICE_FILE"

# Install Service
echo "📦 Installing systemd service..."
cp "$SERVICE_FILE" "$TARGET_FILE"

# Reload and Enable
echo "🔄 Reloading systemd..."
systemctl daemon-reload

echo "✅ Enabling pisowifi service..."
systemctl enable pisowifi

echo "🚀 Starting pisowifi service..."
systemctl restart pisowifi

echo "✅ Piso Wifi Auto-Boot Setup Complete!"
echo "Check status with: systemctl status pisowifi"
