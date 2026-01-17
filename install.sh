#!/bin/bash

# Piso Wifi Installation Script
# Run this on the Orange Pi / Server

echo "🚀 Starting Piso Wifi Installation..."

# 1. Update System
echo "📦 Updating System Repositories..."
apt-get update

# 2. Install System Dependencies (Build tools for better-sqlite3, Network tools)
echo "🛠 Installing System Utilities..."
apt-get install -y curl build-essential python3 iproute2 iptables dnsmasq git ppp pppoe bridge-utils

# 3. Install Node.js (v18)
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "🟢 Installing Node.js v18 & npm..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
    
    # Fallback: If npm is still missing (unlikely with nodesource, but possible on some images)
    if ! command -v npm &> /dev/null; then
        echo "⚠️ npm still missing. Attempting explicit install..."
        apt-get install -y npm
    fi
else
    echo "✅ Node.js is already installed: $(node -v)"
    # Verify npm works
    if ! command -v npm &> /dev/null; then
        echo "⚠️ Node exists but npm is missing. Fixing..."
        apt-get install -y npm
    else
        echo "✅ npm is already installed: $(npm -v)"
    fi
fi

# 4. Install PM2 (Process Manager)
if ! command -v pm2 &> /dev/null; then
    echo "🔄 Installing PM2..."
    npm install -g pm2
else
    echo "✅ PM2 is already installed."
fi

# 5. Install Project Dependencies
echo "📚 Installing Project Dependencies..."
# Ensure we are in the project directory
cd "$(dirname "$0")"

# Remove existing node_modules to ensure clean install if needed (optional)
# rm -rf node_modules

# Install dependencies (with build flags for sqlite)
npm install --build-from-source

# 6. Setup Permissions
echo "🔐 Setting Script Permissions..."
chmod +x src/scripts/*.sh

echo "✨ Installation Complete!"
echo "To start the server, run: npm start"
