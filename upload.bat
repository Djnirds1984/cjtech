@echo off
echo ==========================================
echo      Piso Wifi One-Click Uploader
echo ==========================================
echo.

echo Checking for required tools...

:: Check for tar
where tar >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] 'tar' command not found. Windows 10 or newer required.
    pause
    exit /b
) else (
    echo [OK] tar found.
)

:: Check for scp
where scp >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] 'scp' command not found.
    pause
    exit /b
) else (
    echo [OK] scp found.
)

echo.
set /p IP="20.0.0.230: "
if "%IP%"=="" (
    echo [ERROR] IP Address is required.
    pause
    exit /b
)

set USER=root
set REMOTE_DIR=/root/linux_pisowifi
set DEPLOY_FILE=piso_deploy.tar

echo.
echo [1/4] Packing files...
:: Pack everything except unnecessary files
tar -cvf %DEPLOY_FILE% --exclude "node_modules" --exclude ".git" --exclude "*.tar" --exclude "upload.bat" --exclude "*.sqlite" --exclude "*.log" *
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to pack files.
    pause
    exit /b
)

echo.
echo [2/4] Uploading to %USER%@%IP%...
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null %DEPLOY_FILE% %USER%@%IP%:/root/
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Upload failed.
    del %DEPLOY_FILE%
    pause
    exit /b
)

echo.
echo [3/4] Extracting and Restarting service...
:: 1. Create directory
:: 2. Extract files
:: 3. Remove tar
:: 4. Run install.sh (Handles dependencies & PM2)
:: 5. Restart/Start App
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null %USER%@%IP% "mkdir -p %REMOTE_DIR% && tar -xvf /root/%DEPLOY_FILE% -C %REMOTE_DIR% && rm /root/%DEPLOY_FILE% && cd %REMOTE_DIR% && chmod +x install.sh && ./install.sh && (pm2 restart piso-wifi || pm2 start src/app.js --name piso-wifi)"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Extraction/Restart failed.
    del %DEPLOY_FILE%
    pause
    exit /b
)

echo.
echo [4/4] Cleaning up...
del %DEPLOY_FILE%

echo.
echo ==========================================
echo      Upload Complete!
echo ==========================================
echo.
pause
