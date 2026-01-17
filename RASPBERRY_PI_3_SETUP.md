# Raspberry Pi 3 Setup Guide

This guide provides step-by-step instructions for setting up the Piso Wifi System on Raspberry Pi 3 with enhanced safety and stability features.

## 🚨 Important Safety Notice

The Raspberry Pi 3 GPIO pins have specific limitations:
- **Maximum current per pin: 16mA**
- **Total current for all pins: 50mA**
- **Operating voltage: 3.3V**
- **Never exceed these limits to prevent damage**

## 📋 Prerequisites

- Raspberry Pi 3 Model B or B+
- Micro SD card (8GB minimum)
- Power supply (2.5A minimum)
- Network connection (Ethernet recommended)
- Basic knowledge of GPIO and electronics

## 🔄 Migration Steps (If you have existing installation)

### 1. Backup Original Files
```bash
# Create backup of original files
chmod +x backup-original-files.sh
./backup-original-files.sh
```

### 2. Test New Code Safely
```bash
# Test the new board detection service
node src/services/boardDetectionService-rpi3.js

# Test GPIO safety
sudo node src/scripts/gpio_test_rpi3.js
```

## 🚀 Fresh Installation

### 1. Use Raspberry Pi 3 Optimized Installer
```bash
# Make the installer executable
chmod +x install-rpi3.sh

# Run the installer (recommended as root)
sudo ./install-rpi3.sh
```

### 2. Manual Installation (Alternative)
```bash
# Install dependencies
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl build-essential python3 iproute2 iptables dnsmasq git ppp pppoe bridge-utils sqlite3

# Install WiringPi
sudo apt install -y wiringpi

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Install project dependencies
npm install --build-from-source

# Make scripts executable
chmod +x src/scripts/*.sh
```

## 🔌 GPIO Configuration for Raspberry Pi 3

### Safe GPIO Pins (Recommended)
- **Coin Input: GPIO2 (Physical pin 3)**
- **Relay Output: GPIO27 (Physical pin 13)**
- **Bill Input: GPIO17 (Physical pin 11)**

### Physical Pin Layout
```
 3.3V  (1) (2)  5V
 GPIO2 (3) (4)  5V
 GPIO3 (5) (6)  GND
 GPIO4 (7) (8)  GPIO14
   GND (9) (10) GPIO15
GPIO17 (11) (12) GPIO18
GPIO27 (13) (14) GND
GPIO22 (15) (16) GPIO23
  3.3V (17) (18) GPIO24
GPIO10 (19) (20) GND
 GPIO9 (21) (22) GPIO25
GPIO11 (23) (24) GPIO8
   GND (25) (26) GPIO7
 GPIO0 (27) (28) GPIO1
 GPIO5 (29) (30) GND
 GPIO6 (31) (32) GPIO12
GPIO13 (33) (34) GND
GPIO19 (35) (36) GPIO16
GPIO26 (37) (38) GPIO20
   GND (39) (40) GPIO21
```

## ⚡ Electrical Safety

### Current Limiting Resistors
For input pins (coin/bill acceptors):
- Use 1kΩ resistors in series
- This limits current to ~3.3mA (safe for RPi)

For output pins (relay control):
- Use appropriate transistor driver circuit
- Never connect relay directly to GPIO
- Use opto-isolators for safety

### Wiring Diagram
```
Coin Acceptor → 1kΩ → GPIO2
Bill Acceptor → 1kΩ → GPIO17
Relay Control → Transistor → GPIO27
```

## 🔧 Testing GPIO Safety

### 1. Run Safety Test
```bash
# Test all GPIO pins safely
sudo node src/scripts/gpio_test_rpi3.js
```

### 2. Test Individual Pins
```bash
# Test coin input
sudo node -e "
const { Gpio } = require('onoff');
const pin = new Gpio(2, 'in', 'falling');
console.log('GPIO2 ready for coin input');
pin.unexport();
"

# Test relay output
sudo node -e "
const { Gpio } = require('onoff');
const pin = new Gpio(27, 'out');
pin.writeSync(0); // LOW
console.log('GPIO27 ready for relay control');
pin.unexport();
"
```

## 🚀 Starting the Service

### 1. Start with PM2
```bash
# Start the service
pm2 start src/app.js --name piso-wifi

# Check status
pm2 status

# View logs
pm2 logs piso-wifi
```

### 2. Enable Auto-start
```bash
# Save PM2 configuration
pm2 save

# Setup startup script
pm2 startup
```

## 🔍 Troubleshooting

### GPIO Initialization Errors
If you see "GPIO X is busy" or "EINVAL" errors:
1. Check if pins are already in use: `ls /sys/class/gpio/`
2. Cleanup pins: `echo X | sudo tee /sys/class/gpio/unexport`
3. Restart the service: `pm2 restart piso-wifi`

### System Reboot Issues
If the Pi reboots when starting:
1. Check power supply (minimum 2.5A)
2. Verify GPIO connections aren't shorted
3. Check for system pin conflicts
4. Test with safe pins first

### Permission Issues
```bash
# Add user to gpio group
sudo usermod -a -G gpio $USER

# Fix device permissions
sudo chown root:gpio /dev/gpiochip*
sudo chmod 660 /dev/gpiochip*
```

## 📊 Monitoring

### Check System Status
```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Check voltage
vcgencmd measure_volts

# Check for undervoltage
vcgencmd get_throttled
```

### Monitor GPIO Activity
```bash
# Real-time logs
pm2 logs piso-wifi --lines 50

# Filter for GPIO events
pm2 logs piso-wifi | grep -i gpio
```

## 🔧 Configuration Files

### GPIO Settings
The system automatically configures safe GPIO pins for Raspberry Pi 3:
- Coin: GPIO2 (Physical pin 3)
- Relay: GPIO27 (Physical pin 13)
- Bill: GPIO17 (Physical pin 11)

### Network Configuration
Edit `data/network-config.json` to customize network settings.

### Database
SQLite database is created automatically at `database.sqlite`.

## 🛠️ Maintenance

### Regular Checks
1. **Weekly**: Check GPIO connections and logs
2. **Monthly**: Verify system resources and temperature
3. **Quarterly**: Update software and dependencies

### Updating Software
```bash
# Update system
sudo apt update && sudo apt upgrade

# Update Node.js dependencies
npm update

# Restart service
pm2 restart piso-wifi
```

## 📞 Support

If you encounter issues:
1. Check the logs: `pm2 logs piso-wifi`
2. Run safety test: `sudo node src/scripts/gpio_test_rpi3.js`
3. Verify GPIO configuration
4. Check electrical connections
5. Review this documentation

## ⚠️ Safety Reminders

- **Never exceed 16mA per GPIO pin**
- **Use proper current limiting resistors**
- **Double-check all connections**
- **Test with safe pins first**
- **Monitor system temperature**
- **Keep backup of working configuration**

---

For additional support, check the main [INSTALLATION.md](INSTALLATION.md) file or contact the development team.