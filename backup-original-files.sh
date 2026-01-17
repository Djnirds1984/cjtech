#!/bin/bash

# Backup script for original files before Raspberry Pi 3 overhaul
# This script creates backups of the original files

echo "🔒 Creating backup of original files..."

# Create backup directory
BACKUP_DIR="backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "Backup directory: $BACKUP_DIR"

# Files to backup
FILES_TO_BACKUP=(
    "src/services/boardDetectionService.js"
    "src/services/coinService.js"
    "src/scripts/gpio_test.js"
    "src/scripts/fix_gpio.sh"
    "install.sh"
    "INSTALLATION.md"
)

# Backup each file
for file in "${FILES_TO_BACKUP[@]}"; do
    if [ -f "$file" ]; then
        # Create directory structure in backup
        BACKUP_SUBDIR="$BACKUP_DIR/$(dirname "$file")"
        mkdir -p "$BACKUP_SUBDIR"
        
        # Copy file with timestamp
        cp "$file" "$BACKUP_SUBDIR/$(basename "$file").backup"
        echo "✅ Backed up: $file"
    else
        echo "⚠️  File not found: $file"
    fi
done

# Create a restore script
cat > "$BACKUP_DIR/restore.sh" << 'EOF'
#!/bin/bash

# Restore script for original files
# Usage: ./restore.sh

echo "🔄 Restoring original files..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Files to restore
FILES_TO_RESTORE=(
    "src/services/boardDetectionService.js.backup"
    "src/services/coinService.js.backup"
    "src/scripts/gpio_test.js.backup"
    "src/scripts/fix_gpio.sh.backup"
    "install.sh.backup"
    "INSTALLATION.md.backup"
)

# Restore each file
for backup_file in "${FILES_TO_RESTORE[@]}"; do
    if [ -f "$SCRIPT_DIR/$backup_file" ]; then
        # Remove .backup extension to get original filename
        original_file="${backup_file%.backup}"
        
        # Copy back to original location
        cp "$SCRIPT_DIR/$backup_file" "$original_file"
        echo "✅ Restored: $original_file"
    else
        echo "⚠️  Backup file not found: $backup_file"
    fi
done

echo "✅ Restore completed!"
echo "⚠️  You may need to restart the service for changes to take effect"
EOF

chmod +x "$BACKUP_DIR/restore.sh"

echo ""
echo "✅ Backup completed successfully!"
echo "📁 Backup location: $BACKUP_DIR"
echo "🔄 To restore original files, run: $BACKUP_DIR/restore.sh"
echo ""
echo "📋 Backup contents:"
ls -la "$BACKUP_DIR"

echo ""
echo "📝 Next steps for Raspberry Pi 3 overhaul:"
echo "1. Test the new services: node src/services/boardDetectionService-rpi3.js"
echo "2. Test GPIO safety: node src/scripts/gpio_test_rpi3.js"
echo "3. Use the new installation script: sudo ./install-rpi3.sh"
echo "4. If anything goes wrong, restore with: ./backups/*/restore.sh"