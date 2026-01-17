# GPIO Troubleshooting Guide for Raspberry Pi 3

## 🚨 Common GPIO Issues and Solutions

### Issue 1: "fs is not defined" Error
**Problem**: The GPIO test script fails with "fs is not defined"
**Solution**: The fs module import is missing. This has been fixed in the updated scripts.

```bash
# Use the fixed script
sudo node src/scripts/gpio_test_rpi3_fixed.js
```

### Issue 2: "EINVAL: invalid argument, write" Error
**Problem**: GPIO pins fail to initialize with EINVAL errors
**Possible Causes**:
1. **GPIO pins are already in use** by other processes
2. **Insufficient permissions** (not running as root)
3. **GPIO kernel modules not loaded**
4. **Hardware conflicts** with system pins

**Solutions**:

#### Step 1: Check System Status
```bash
# Run comprehensive diagnostic
sudo node src/scripts/gpio_diagnostic_rpi3.js

# Check if running as root
whoami  # Should show 'root'

# Check GPIO permissions
ls -la /dev/gpiochip*
ls -la /dev/gpiomem
```

#### Step 2: Check for Busy GPIOs
```bash
# Check currently exported GPIOs
ls /sys/class/gpio/

# Check if pins are in use
lsof /sys/class/gpio/gpio2 2>/dev/null
lsof /sys/class/gpio/gpio17 2>/dev/null
lsof /sys/class/gpio/gpio27 2>/dev/null
```

#### Step 3: Cleanup GPIO Pins
```bash
# Manually unexport problematic pins
echo 2 | sudo tee /sys/class/gpio/unexport
echo 17 | sudo tee /sys/class/gpio/unexport
echo 27 | sudo tee /sys/class/gpio/unexport

# Or use the cleanup script
sudo ./src/scripts/fix_gpio.sh
```

### Issue 3: System Reboot on GPIO Initialization
**Problem**: Raspberry Pi reboots when starting the service
**Critical Safety Measures**:

#### Immediate Actions:
1. **Disconnect all GPIO hardware** temporarily
2. **Check power supply** (minimum 2.5A for Pi 3)
3. **Verify no short circuits** in wiring
4. **Test with safe pins first**

#### Safe GPIO Pins for Raspberry Pi 3:
- **Coin Input**: GPIO2 (Physical pin 3) - SDA1
- **Relay Output**: GPIO27 (Physical pin 13)
- **Bill Input**: GPIO17 (Physical pin 11)

#### Pins to AVOID (System Pins):
- GPIO0, GPIO1, GPIO5, GPIO6, GPIO12, GPIO13, GPIO16, GPIO19, GPIO20, GPIO21, GPIO26

### Issue 4: Permission Denied Errors
**Problem**: "EACCES: permission denied" errors
**Solutions**:

```bash
# Add user to gpio group
sudo usermod -a -G gpio $USER

# Fix device permissions
sudo chown root:gpio /dev/gpiochip*
sudo chmod 660 /dev/gpiochip*
sudo chown root:gpio /dev/gpiomem
sudo chmod 660 /dev/gpiomem

# Create gpio group if it doesn't exist
sudo groupadd gpio
```

### Issue 5: GPIO Kernel Module Issues
**Problem**: GPIO sysfs interface not available
**Solutions**:

```bash
# Check if GPIO modules are loaded
lsmod | grep gpio

# Load GPIO modules if needed
sudo modprobe gpio_bcm2835
sudo modprobe gpio_generic

# Check kernel messages
dmesg | grep gpio
```

## 🔧 Step-by-Step GPIO Testing Process

### 1. Initial System Check
```bash
# Check system information
sudo node src/scripts/gpio_diagnostic_rpi3.js

# Verify Raspberry Pi 3 detection
cat /proc/device-tree/model
cat /proc/cpuinfo | grep Hardware
```

### 2. Test GPIO Pins Safely
```bash
# Use the enhanced test script
sudo node src/scripts/gpio_test_rpi3_fixed.js

# This will:
# - Test each GPIO pin individually
# - Find alternative pins if primary ones fail
# - Provide configuration recommendations
# - Update the database with working pins
```

### 3. Automatic Configuration Update
```bash
# Use the configuration updater
sudo node src/scripts/update_gpio_config.js

# This will:
# - Test all available GPIO pins
# - Find working combinations
# - Update the database automatically
# - Provide wiring instructions
```

### 4. Manual Pin Testing (if automatic fails)
```bash
# Test individual pins manually
sudo node -e "
const { Gpio } = require('onoff');

// Test GPIO 2 (coin input)
try {
  const gpio2 = new Gpio(2, 'in', 'falling');
  console.log('GPIO 2: OK');
  gpio2.unexport();
} catch (e) {
  console.log('GPIO 2: FAILED -', e.message);
}

// Test GPIO 17 (bill input)
try {
  const gpio17 = new Gpio(17, 'in', 'falling');
  console.log('GPIO 17: OK');
  gpio17.unexport();
} catch (e) {
  console.log('GPIO 17: FAILED -', e.message);
}

// Test GPIO 27 (relay output)
try {
  const gpio27 = new Gpio(27, 'out');
  gpio27.writeSync(0);
  console.log('GPIO 27: OK');
  gpio27.unexport();
} catch (e) {
  console.log('GPIO 27: FAILED -', e.message);
}
"
```

## 📋 GPIO Pin Reference for Raspberry Pi 3

### Physical Pin Layout (40-pin header):
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

### Recommended Pin Assignments:
- **Coin Acceptor**: GPIO2 (Pin 3) - with 1kΩ resistor
- **Bill Validator**: GPIO17 (Pin 11) - with 1kΩ resistor  
- **Relay Control**: GPIO27 (Pin 13) - with transistor driver

### Alternative Pins (if primary ones fail):
- **Coin/Bill Inputs**: GPIO3, GPIO4, GPIO22, GPIO23, GPIO24, GPIO25
- **Relay Output**: GPIO18, GPIO22, GPIO23, GPIO24, GPIO25

## ⚡ Electrical Safety Guidelines

### Current Limiting:
- **Maximum per pin**: 16mA
- **Total for all pins**: 50mA
- **Use 1kΩ resistors** for input pins (limits to ~3.3mA)

### Wiring Diagram:
```
Coin Acceptor → 1kΩ → GPIO2 (Pin 3)
Bill Acceptor → 1kΩ → GPIO17 (Pin 11)
Relay Control → Transistor → GPIO27 (Pin 13)
```

### Power Supply Requirements:
- **Minimum**: 2.5A at 5V
- **Recommended**: 3.0A for stable operation
- **Check for undervoltage**: `vcgencmd get_throttled`

## 🚀 Service Startup Process

### 1. Pre-startup Checks
```bash
# Check system resources
free -h              # Memory
df -h .              # Disk space
vcgencmd measure_temp # Temperature
vcgencmd get_throttled # Power issues

# Check GPIO status
ls /sys/class/gpio/
cat /proc/cpuinfo | grep Hardware
```

### 2. Start Service Safely
```bash
# Stop any existing service
pm2 stop piso-wifi

# Test GPIO configuration first
sudo node src/scripts/gpio_test_rpi3_fixed.js

# If successful, start the service
pm2 start src/app.js --name piso-wifi

# Monitor startup
pm2 logs piso-wifi --lines 50
```

### 3. Verify Operation
```bash
# Check service status
pm2 status

# Test web interface
curl -I http://localhost:3000/portal

# Monitor GPIO activity
pm2 logs piso-wifi | grep -i gpio
```

## 🔍 Advanced Troubleshooting

### Kernel Module Issues
```bash
# Check loaded modules
lsmod | grep gpio

# Load specific modules
sudo modprobe gpio_bcm2835
sudo modprobe gpio_generic

# Check device tree
ls /proc/device-tree/soc/gpio@*
```

### Device Tree Overlays
```bash
# Check current overlays
cat /boot/config.txt | grep dtoverlay

# Enable GPIO overlay if needed
echo "dtoverlay=gpio-poweroff,gpiopin=26" | sudo tee -a /boot/config.txt
```

### Memory and Resource Issues
```bash
# Check memory usage
free -h
cat /proc/meminfo | grep MemAvailable

# Check for memory leaks
ps aux | grep node

# Monitor system logs
journalctl -f | grep -i gpio
```

## 🛠️ Emergency Recovery

If the system becomes unstable:

1. **Boot in safe mode** by holding SHIFT during startup
2. **Edit config.txt** to disable problematic overlays
3. **Use backup configuration** from `backups/` directory
4. **Restore original files** using `./backups/*/restore.sh`

## 📞 Getting Help

If issues persist:

1. **Run diagnostic script**: `sudo node src/scripts/gpio_diagnostic_rpi3.js`
2. **Check logs**: `pm2 logs piso-wifi` and `journalctl -xe`
3. **Test with minimal setup** (no hardware connected)
4. **Verify power supply** and wiring
5. **Consider alternative GPIO pins** if primary ones fail

---

**Remember**: Always test GPIO pins safely before connecting external hardware. The Raspberry Pi 3 GPIO pins are sensitive and can be damaged by incorrect wiring or excessive current.