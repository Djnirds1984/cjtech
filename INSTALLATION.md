# Piso Wifi System - Installation Guide

## Overview

This guide provides comprehensive instructions for installing and setting up the Piso Wifi System, a Linux-based WiFi hotspot management system designed for single-board computers like Orange Pi and Raspberry Pi.

## 1. Prerequisites

### System Requirements

#### Hardware Requirements
- **Single Board Computer**: Orange Pi, Raspberry Pi, or any x86 Mini PC
- **Network Interfaces**:
  - **WAN Interface**: Internet source (Ethernet `eth0` or WiFi client)
  - **Hotspot Interface**: Access point for users (WiFi AP `wlan0` or USB LAN)
- **Storage**: Minimum 8GB SD card or storage device
- **RAM**: Minimum 512MB (1GB+ recommended)

#### Software Requirements
- **Operating System**: Ubuntu 20.04/22.04 LTS or Armbian
- **User Access**: Root access required for network management
- **Node.js**: Version 18.0.0 or higher
- **NPM**: Version 8.0.0 or higher
- **PM2**: Process manager for Node.js applications

### Required Dependencies

#### System Dependencies
- `build-essential` - Build tools for native modules
- `python3` - Python 3 runtime
- `iproute2` - Network configuration tools
- `iptables` - Firewall management
- `dnsmasq` - DNS and DHCP server
- `git` - Version control system
- `curl` - Data transfer tool
- `ppp` - Point-to-Point Protocol
- `pppoe` - PPP over Ethernet
- `bridge-utils` - Ethernet bridge utilities

#### Node.js Dependencies
- `express` (^4.18.2) - Web framework
- `better-sqlite3` (^9.0.0) - SQLite database
- `socket.io` (^4.7.2) - Real-time communication
- `onoff` (^6.0.3) - GPIO access
- `cors` (^2.8.5) - Cross-origin resource sharing
- `body-parser` (^1.20.2) - Request body parsing
- `cookie-parser` (^1.4.6) - Cookie parsing
- `chart.js` (^4.4.1) - Chart generation

## 2. Installation Steps

### Method 1: Automated Installation (Recommended)

1. **Clone or download the project files** to your target device:
   ```bash
   git clone <repository-url> linux_pisowifi
   cd linux_pisowifi
   ```

2. **Run the automated installation script**:
   ```bash
   sudo chmod +x install.sh
   sudo ./install.sh
   ```

3. **The script will automatically**:
   - Update system repositories
   - Install all system dependencies
   - Install Node.js 18.x and npm
   - Install PM2 globally
   - Install project dependencies
   - Set proper file permissions

### Method 2: Manual Installation

1. **Update System Packages**:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

2. **Install System Dependencies**:
   ```bash
   sudo apt install -y curl build-essential python3 iproute2 iptables dnsmasq git ppp pppoe bridge-utils
   ```

3. **Install Node.js 18.x**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
   sudo apt install -y nodejs
   ```

4. **Install PM2 Process Manager**:
   ```bash
   sudo npm install -g pm2
   ```

5. **Install Project Dependencies**:
   ```bash
   cd linux_pisowifi
   npm install --build-from-source
   ```

6. **Set Script Permissions**:
   ```bash
   sudo chmod +x src/scripts/*.sh
   ```

### Method 3: Windows Deployment (Development)

1. **Edit the upload configuration**:
   - Open `upload.bat` in a text editor
   - Update the IP address and path settings:
   ```bat
   set USER=root
   set REMOTE_PATH=/root/linux_pisowifi
   ```

2. **Run the deployment script**:
   ```cmd
   upload.bat
   ```

3. **Enter the target device IP** when prompted

4. **Enter SSH password** (if not using key-based authentication)

## 3. Configuration

### Network Configuration

The system uses `data/network-config.json` for network settings:

```json
{
  "wan": {
    "interface": "eth0",
    "mode": "dynamic",
    "static": {
      "ip": "",
      "netmask": "255.255.255.0",
      "gateway": "",
      "dns1": "8.8.8.8",
      "dns2": "8.8.4.4"
    },
    "pppoe": {
      "username": "",
      "password": ""
    }
  },
  "vlans": [],
  "bridges": [
    {
      "name": "br0",
      "ip": "10.0.0.1",
      "netmask": "255.255.255.0",
      "stp": false,
      "interfaces": []
    }
  ]
}
```

#### Customizing Network Interfaces

Edit `src/services/networkService.js` to change default interfaces:

```javascript
// Default interfaces - modify these for your setup
const HOTSPOT_INTERFACE = 'wlan0';  // Your AP interface
const WAN_INTERFACE = 'eth0';         // Your internet source
```

### Environment Variables

No additional environment variables are required for basic operation. The system will:
- Create SQLite database automatically on first run
- Use default network configuration from `network-config.json`
- Apply iptables rules automatically

### Database Configuration

The system uses SQLite with automatic database creation:
- **Database file**: `database.sqlite` (created automatically)
- **Tables**: Users, sales, admins, sessions
- **Location**: Project root directory

## 4. Verification

### Starting the Service

1. **Start with PM2** (recommended for production):
   ```bash
   pm2 start src/app.js --name piso-wifi
   ```

2. **Enable auto-start on boot**:
   ```bash
   pm2 save
   pm2 startup
   ```

### Verification Commands

1. **Check service status**:
   ```bash
   pm2 status
   ```
   
   Expected output:
   ```
   ┌─────┬─────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐
   │ id  │ name        │ namespace   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │ cpu      │ mem      │ user     │ watching │
   ├─────┼─────────────┼─────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┼──────────┼──────────┼──────────┼──────────┤
   │ 0   │ piso-wifi   │ default     │ 1.0.0   │ fork    │ 1234     │ 2m     │ 0    │ online    │ 0%       │ 45.2mb   │ root     │ disabled │
   └─────┴─────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘
   ```

2. **View real-time logs**:
   ```bash
   pm2 logs piso-wifi
   ```

3. **Test network connectivity**:
   ```bash
   curl -I http://localhost:3000/portal
   ```
   
   Expected output:
   ```
   HTTP/1.1 200 OK
   X-Powered-By: Express
   Content-Type: text/html; charset=utf-8
   ```

4. **Check if service is listening**:
   ```bash
   netstat -tlnp | grep :3000
   ```
   
   Expected output:
   ```
   tcp   0   0 0.0.0.0:3000   0.0.0.0:*   LISTEN   1234/node
   ```

### Access Points

- **Client Portal**: `http://10.0.0.1:3000/portal`
- **Admin Panel**: `http://10.0.0.1:3000/admin`

## 5. Troubleshooting

### Common Installation Issues

#### Error: "Cannot find module" or "ENOENT: no such file"

**Cause**: Missing dependencies or incorrect working directory

**Solution**:
```bash
# Ensure you're in the correct directory
cd /path/to/linux_pisowifi

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install --build-from-source
```

#### Error: "Could not locate the bindings file" or "opening dependency file ... No such file"

**Cause**: Build race condition on ARM devices

**Solution 1** (Recommended):
```bash
# Update build tools
npm install -g node-gyp

# Clean and rebuild
rm -rf node_modules package-lock.json
npm install
```

**Solution 2** (Force single-threaded):
```bash
npm install --jobs=1
```

#### Error: "Permission Denied" or "EACCES"

**Cause**: Insufficient permissions for network operations

**Solution**:
```bash
# Run as root or with sudo
sudo pm2 start src/app.js --name piso-wifi
```

#### Error: "EBUSY" or GPIO Pin Issues

**Cause**: GPIO pins already in use or not accessible

**Solution**:
```bash
# Stop the service
pm2 stop piso-wifi

# Run GPIO diagnostic
sudo node src/scripts/gpio_test.js

# Fix GPIO conflicts
sudo ./src/scripts/fix_gpio.sh

# Restart service
pm2 restart piso-wifi
```

### Service Management Issues

#### Service Won't Start

1. **Check logs for errors**:
   ```bash
   pm2 logs piso-wifi --lines 50
   ```

2. **Verify Node.js version**:
   ```bash
   node --version
   ```
   
   Should be 18.x or higher

3. **Check port availability**:
   ```bash
   sudo lsof -i :3000
   ```

#### Service Crashes on Boot

1. **Ensure PM2 startup is configured**:
   ```bash
   pm2 save
   pm2 startup
   ```

2. **Check system logs**:
   ```bash
   journalctl -u pm2-root -n 50
   ```

### Network Configuration Issues

#### Captive Portal Not Appearing

1. **Check dnsmasq status**:
   ```bash
   sudo systemctl status dnsmasq
   ```

2. **Verify iptables rules**:
   ```bash
   sudo iptables -L -t nat
   ```

3. **Test DHCP functionality**:
   ```bash
   sudo systemctl restart dnsmasq
   ```

#### Clients Not Getting IP Addresses

1. **Check network interface configuration**:
   ```bash
   ip addr show wlan0
   ```

2. **Verify dnsmasq configuration**:
   ```bash
   sudo cat /etc/dnsmasq.conf
   ```

### Database Issues

#### Database Locked or Corrupted

1. **Stop the service**:
   ```bash
   pm2 stop piso-wifi
   ```

2. **Remove corrupted database** (⚠️ Warning: This deletes all data):
   ```bash
   rm database.sqlite
   ```

3. **Restart service** (database will be recreated):
   ```bash
   pm2 start piso-wifi
   ```

### Getting Help

If you encounter issues not covered here:

1. **Check the logs first**:
   ```bash
   pm2 logs piso-wifi --lines 100
   ```

2. **Verify system requirements** are met

3. **Ensure all dependencies** are properly installed

4. **Check file permissions** and ownership

5. **Review network configuration** files

## Quick Reference

### Essential Commands
```bash
# Start service
pm2 start src/app.js --name piso-wifi

# View logs
pm2 logs piso-wifi

# Restart service
pm2 restart piso-wifi

# Stop service
pm2 stop piso-wifi

# Check status
pm2 status

# View all PM2 processes
pm2 list
```

### File Locations
- **Main application**: `src/app.js`
- **Network config**: `data/network-config.json`
- **Database**: `database.sqlite`
- **Scripts**: `src/scripts/`
- **Services**: `src/services/`
- **Web interface**: `public/`

### Default Access Points
- **Client Portal**: `http://10.0.0.1:3000/portal`
- **Admin Panel**: `http://10.0.0.1:3000/admin`
- **API Base**: `http://10.0.0.1:3000/api`

---

*For additional support, please refer to the project's README.md file or contact the development team.*