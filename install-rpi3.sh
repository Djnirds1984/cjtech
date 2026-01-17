#!/bin/bash

# Piso Wifi Installation Script for Raspberry Pi 3
# This script provides enhanced safety and compatibility for Raspberry Pi 3

echo "🚀 Starting Piso Wifi Installation for Raspberry Pi 3..."
echo "⚠️  This script includes safety measures to prevent system crashes"

# Function to check if this is a Raspberry Pi 3
check_raspberry_pi_3() {
    if [ -f /proc/device-tree/model ]; then
        MODEL=$(cat /proc/device-tree/model | tr -d '\0')
        if [[ "$MODEL" == *"Raspberry Pi 3"* ]]; then
            echo "✅ Raspberry Pi 3 detected: $MODEL"
            return 0
        fi
    fi
    
    if [ -f /proc/cpuinfo ]; then
        HARDWARE=$(grep "^Hardware" /proc/cpuinfo | cut -d: -f2 | tr -d ' ')
        if [[ "$HARDWARE" == *"BCM2835"* ]] || [[ "$HARDWARE" == *"BCM2837"* ]]; then
            echo "✅ Raspberry Pi 3 hardware detected: $HARDWARE"
            return 0
        fi
    fi
    
    echo "⚠️  This does not appear to be a Raspberry Pi 3"
    echo "⚠️  Continue anyway? (y/N)"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "Installation cancelled"
        exit 1
    fi
    return 0
}

# Function to create gpio group if it doesn't exist
setup_gpio_group() {
    echo "🔌 Setting up GPIO group..."
    
    if ! getent group gpio > /dev/null 2>&1; then
        echo "Creating gpio group..."
        sudo groupadd gpio
        echo "✅ GPIO group created"
    else
        echo "✅ GPIO group already exists"
    fi
    
    # Add current user to gpio group
    sudo usermod -a -G gpio $USER
    echo "✅ Added user to gpio group"
    
    # Set up GPIO device permissions
    echo "Setting GPIO device permissions..."
    sudo chown root:gpio /dev/gpiochip* 2>/dev/null || true
    sudo chmod 660 /dev/gpiochip* 2>/dev/null || true
    sudo chown root:gpio /dev/gpiomem 2>/dev/null || true
    sudo chmod 660 /dev/gpiomem 2>/dev/null || true
    echo "✅ GPIO permissions configured"
}

# Function to install WiringPi safely
install_wiringpi_safe() {
    echo "🔌 Installing WiringPi for Raspberry Pi 3..."
    
    # Try apt installation first (newer Raspberry Pi OS)
    if apt-cache show wiringpi > /dev/null 2>&1; then
        echo "Installing WiringPi via apt..."
        apt-get install -y wiringpi
        if command -v gpio > /dev/null 2>&1; then
            echo "✅ WiringPi installed successfully via apt"
            gpio -v
            return 0
        fi
    fi
    
    # Manual installation from source
    echo "Installing WiringPi from source..."
    cd /tmp
    
    # Remove any existing WiringPi directory
    rm -rf WiringPi
    
    # Clone the repository
    if git clone https://github.com/WiringPi/WiringPi.git; then
        cd WiringPi
        
        # Build and install
        if ./build; then
            echo "✅ WiringPi built and installed successfully"
            gpio -v
        else
            echo "❌ WiringPi build failed"
            echo "⚠️  GPIO functionality may be limited, but the system will still work"
        fi
        
        cd /tmp
        rm -rf WiringPi
    else
        echo "❌ Failed to clone WiringPi repository"
        echo "⚠️  GPIO functionality may be limited, but the system will still work"
    fi
}

# Function to check system resources
check_system_resources() {
    echo "🔍 Checking system resources..."
    
    # Check memory
    if [ -f /proc/meminfo ]; then
        MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        MEM_MB=$((MEM_KB / 1024))
        echo "Memory: ${MEM_MB}MB"
        
        if [ $MEM_MB -lt 512 ]; then
            echo "⚠️  Low memory detected (${MEM_MB}MB). System may be unstable."
            echo "⚠️  Consider using a Raspberry Pi with more RAM."
        else
            echo "✅ Memory is sufficient"
        fi
    fi
    
    # Check disk space
    DISK_AVAIL=$(df . | tail -1 | awk '{print $4}')
    DISK_MB=$((DISK_AVAIL / 1024))
    echo "Disk space available: ${DISK_MB}MB"
    
    if [ $DISK_MB -lt 1000 ]; then
        echo "⚠️  Low disk space detected (${DISK_MB}MB)"
        echo "⚠️  Consider freeing up some space."
    else
        echo "✅ Disk space is sufficient"
    fi
    
    # Check if running as root
    if [ "$EUID" -eq 0 ]; then
        echo "✅ Running as root (recommended for GPIO access)"
    else
        echo "⚠️  Not running as root - GPIO operations may fail"
        echo "⚠️  Consider running: sudo $0"
    fi
}

# Function to install system dependencies safely
install_system_dependencies() {
    echo "📦 Installing system dependencies..."
    
    # Update system
    echo "Updating package lists..."
    apt-get update
    
    # Install essential packages
    echo "Installing essential packages..."
    apt-get install -y \
        curl \
        build-essential \
        python3 \
        python3-pip \
        iproute2 \
        iptables \
        dnsmasq \
        git \
        ppp \
        pppoe \
        bridge-utils \
        sqlite3 \
        libsqlite3-dev
    
    echo "✅ System dependencies installed"
}

# Function to install Node.js
install_nodejs() {
    echo "🟢 Installing Node.js..."
    
    # Check if Node.js is already installed
    if command -v node > /dev/null 2>&1; then
        NODE_VERSION=$(node --version)
        echo "Node.js is already installed: $NODE_VERSION"
        
        # Check if version is 18 or higher
        if [[ "$NODE_VERSION" =~ ^v(1[8-9]|[2-9][0-9]) ]]; then
            echo "✅ Node.js version is sufficient"
            return 0
        else
            echo "⚠️  Node.js version is too old, updating..."
        fi
    fi
    
    # Install Node.js 18.x
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
    
    # Verify installation
    if command -v node > /dev/null 2>&1 && command -v npm > /dev/null 2>&1; then
        echo "✅ Node.js $(node --version) and npm $(npm --version) installed successfully"
    else
        echo "❌ Node.js installation failed"
        exit 1
    fi
}

# Function to install PM2
install_pm2() {
    echo "🔄 Installing PM2 process manager..."
    
    if command -v pm2 > /dev/null 2>&1; then
        echo "✅ PM2 is already installed"
        pm2 --version
    else
        npm install -g pm2
        if command -v pm2 > /dev/null 2>&1; then
            echo "✅ PM2 installed successfully"
        else
            echo "❌ PM2 installation failed"
            exit 1
        fi
    fi
}

# Function to set up project
setup_project() {
    echo "📚 Setting up project..."
    
    # Get current directory
    PROJECT_DIR=$(pwd)
    echo "Project directory: $PROJECT_DIR"
    
    # Install Node.js dependencies
    echo "Installing Node.js dependencies..."
    npm install --build-from-source
    
    # Make scripts executable
    echo "Setting script permissions..."
    chmod +x src/scripts/*.sh
    
    echo "✅ Project setup completed"
}

# Function to configure safe GPIO defaults for Raspberry Pi 3
configure_safe_gpio() {
    echo "🔧 Configuring safe GPIO defaults for Raspberry Pi 3..."
    
    # Create default configuration if it doesn't exist
    if [ ! -f "database.sqlite" ]; then
        echo "Creating default database with safe GPIO settings..."
        
        # Create a simple SQLite database with safe defaults
        sqlite3 database.sqlite << EOF
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Safe GPIO pins for Raspberry Pi 3
INSERT OR REPLACE INTO config (key, value) VALUES ('coin_pin', '2');        -- GPIO2 (Physical pin 3)
INSERT OR REPLACE INTO config (key, value) VALUES ('relay_pin', '27');     -- GPIO27 (Physical pin 13)
INSERT OR REPLACE INTO config (key, value) VALUES ('bill_pin', '17');      -- GPIO17 (Physical pin 11)
INSERT OR REPLACE INTO config (key, value) VALUES ('coin_pin_edge', 'falling');
INSERT OR REPLACE INTO config (key, value) VALUES ('bill_pin_edge', 'falling');
INSERT OR REPLACE INTO config (key, value) VALUES ('bill_multiplier', '1');
INSERT OR REPLACE INTO config (key, value) VALUES ('ban_limit_counter', '10');
INSERT OR REPLACE INTO config (key, value) VALUES ('ban_duration', '1');

-- Verify the settings
SELECT * FROM config WHERE key LIKE '%pin%';
EOF
        
        echo "✅ Safe GPIO configuration created"
    else
        echo "✅ Database already exists"
    fi
}

# Function to test GPIO safety
test_gpio_safety() {
    echo "🧪 Testing GPIO safety..."
    
    if [ -f "src/scripts/gpio_test_rpi3.js" ]; then
        echo "Running Raspberry Pi 3 GPIO safety test..."
        node src/scripts/gpio_test_rpi3.js
    else
        echo "⚠️  GPIO safety test script not found"
    fi
}

# Function to create systemd service
create_systemd_service() {
    echo "🔧 Creating systemd service..."
    
    if [ -f "pisowifi.service.template" ]; then
        # Replace placeholders in the template
        sed "s|{{WORKING_DIRECTORY}}|$PWD|g" pisowifi.service.template > pisowifi.service
        
        # Copy to systemd directory
        sudo cp pisowifi.service /etc/systemd/system/
        
        # Enable and start the service
        sudo systemctl daemon-reload
        sudo systemctl enable pisowifi.service
        
        echo "✅ Systemd service created and enabled"
        echo "To start the service: sudo systemctl start pisowifi"
        echo "To check status: sudo systemctl status pisowifi"
    else
        echo "⚠️  Service template not found, skipping systemd setup"
    fi
}

# Function to display final instructions
show_final_instructions() {
    echo ""
    echo "🎉 Installation completed successfully!"
    echo ""
    echo "📋 Next steps:"
    echo "1. Test GPIO safety: sudo node src/scripts/gpio_test_rpi3.js"
    echo "2. Start the service: pm2 start src/app.js --name piso-wifi"
    echo "3. Save PM2 config: pm2 save"
    echo "4. Setup PM2 startup: pm2 startup"
    echo ""
    echo "🔌 GPIO Configuration for Raspberry Pi 3:"
    echo "   Coin:  GPIO2  (Physical pin 3)"
    echo "   Relay: GPIO27 (Physical pin 13)"
    echo "   Bill:  GPIO17 (Physical pin 11)"
    echo ""
    echo "⚠️  Important Safety Notes:"
    echo "   - Maximum current per GPIO pin: 16mA"
    echo "   - Total current for all pins: 50mA"
    echo "   - Never connect devices that draw more than 16mA"
    echo "   - Always use proper current limiting resistors"
    echo "   - Double-check your wiring before connecting devices"
    echo ""
    echo "🌐 Access the system at:"
    echo "   Client Portal: http://10.0.0.1:3000/portal"
    echo "   Admin Panel:   http://10.0.0.1:3000/admin"
    echo ""
    echo "📚 For help and troubleshooting, check the INSTALLATION.md file"
}

# Main installation process
main() {
    echo "🚀 Starting Raspberry Pi 3 optimized installation..."
    
    # Check if this is a Raspberry Pi 3
    check_raspberry_pi_3
    
    # Setup GPIO group and permissions
    setup_gpio_group
    
    # Check system resources
    check_system_resources
    
    # Install system dependencies
    install_system_dependencies
    
    # Install WiringPi safely
    install_wiringpi_safe
    
    # Install Node.js
    install_nodejs
    
    # Install PM2
    install_pm2
    
    # Setup project
    setup_project
    
    # Configure safe GPIO defaults
    configure_safe_gpio
    
    # Test GPIO safety
    test_gpio_safety
    
    # Create systemd service
    create_systemd_service
    
    # Show final instructions
    show_final_instructions
}

# Run main function
main "$@"