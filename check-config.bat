@echo off
echo ====================================
echo Claude Desktop Config Checker
echo ====================================
echo.

set CONFIG_PATH=%APPDATA%\Claude\claude_desktop_config.json

if exist "%CONFIG_PATH%" (
    echo Found config file at:
    echo %CONFIG_PATH%
    echo.
    echo Current contents:
    echo ====================================
    type "%CONFIG_PATH%"
    echo.
    echo ====================================
    echo.

    findstr /C:"railway" "%CONFIG_PATH%" >nul
    if %ERRORLEVEL% EQU 0 (
        echo [ERROR] Found Railway URL in config!
        echo You need to replace it with the Render URL.
        echo.
        echo Run fix-config.ps1 to automatically fix this.
    ) else (
        findstr /C:"onrender.com" "%CONFIG_PATH%" >nul
        if %ERRORLEVEL% EQU 0 (
            echo [OK] Render URL is configured correctly!
        ) else (
            echo [WARNING] No RecallBricks API URL found in config
        )
    )
) else (
    echo [ERROR] Config file not found at:
    echo %CONFIG_PATH%
    echo.
    echo Please check your Claude Desktop installation.
)

echo.
pause
