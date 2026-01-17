# Linux PisoWifi System

## Installation & Setup

### 1. Prerequisites
- Node.js (v16+)
- NPM
- PM2 (Process Manager)

### 2. Installation
Navigate to the project directory:
```bash
cd linux_pisowifi
```

Install dependencies:
```bash
npm install
```

### 3. Starting the Server
Start the application using PM2 (recommended for production):
```bash
pm2 start src/app.js --name piso-wifi
```

To make sure it starts automatically on reboot:
```bash
pm2 save
pm2 startup
```

### 4. Management Commands
- **View Logs:** `pm2 logs piso-wifi`
- **Restart:** `pm2 restart piso-wifi`
- **Stop:** `pm2 stop piso-wifi`
- **Status:** `pm2 status`

### 5. Troubleshooting
If you see `Error: Cannot find module` or `ENOENT: no such file`, ensure you are inside the `linux_pisowifi` directory before running commands.

#### GPIO Issues (Coin Slot/Relay Not Working)
If you encounter errors related to GPIO (e.g., `EBUSY` or pins not responding), especially with **PA12**, **PA11**, or **PA19**, the system now attempts to auto-fix this on startup.

**To Test Pins Manually:**
1. Stop the main service:
   ```bash
   pm2 stop piso-wifi
   ```
2. Run the diagnostic tool:
   ```bash
   sudo node src/scripts/gpio_test.js
   ```
   *This will blink the relay and wait for coin/bill pulses.*

**To Fix "EBUSY" Errors:**
You can also manually run the fix script:
```bash
sudo ./src/scripts/fix_gpio.sh
```
Or restart the service:
```bash
pm2 restart piso-wifi
```
