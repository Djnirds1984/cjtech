#!/bin/bash

# PisoWifi System Dependency Installer
# Run this script as root

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit 1
fi

echo "Updating package lists..."
apt-get update

echo "Installing required system packages..."
apt-get install -y \
    dnsmasq \
    iptables \
    bridge-utils \
    net-tools \
    ppp \
    pppoe \
    curl \
    iproute2 \
    nodejs \
    npm

echo "Installing ZeroTier..."
# ZEROTIER ACTIVATION
curl -s https://install.zerotier.com | sudo bash

echo "System dependencies installed successfully."
echo "You can now run the PisoWifi server."
