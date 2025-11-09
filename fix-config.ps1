# PowerShell script to fix Claude Desktop config for Render migration

Write-Host "🔍 Searching for Claude Desktop config..." -ForegroundColor Cyan

# Find the config file
$configPath = "$env:APPDATA\Claude\claude_desktop_config.json"

if (-Not (Test-Path $configPath)) {
    Write-Host "❌ Config file not found at: $configPath" -ForegroundColor Red
    Write-Host "Please locate your claude_desktop_config.json manually" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Found config at: $configPath" -ForegroundColor Green

# Read the current config
$config = Get-Content $configPath -Raw
Write-Host ""
Write-Host "📄 Current configuration:" -ForegroundColor Cyan
Write-Host $config

# Check if it contains the old Railway URL
if ($config -match "railway") {
    Write-Host ""
    Write-Host "⚠️  Found Railway URL in config!" -ForegroundColor Yellow
    Write-Host ""

    # Backup the config
    $backupPath = "$configPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $configPath $backupPath
    Write-Host "💾 Backup created at: $backupPath" -ForegroundColor Green

    # Replace Railway with Render
    $newConfig = $config -replace "https://recallbricks-api-production\.up\.railway\.app", "https://recallbricks-api-clean.onrender.com"

    # Save the updated config
    $newConfig | Set-Content $configPath -NoNewline

    Write-Host ""
    Write-Host "✅ Config updated successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📄 New configuration:" -ForegroundColor Cyan
    Write-Host $newConfig
    Write-Host ""
    Write-Host "🔄 Please restart Claude Desktop for changes to take effect" -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "✅ No Railway URL found - config looks good!" -ForegroundColor Green

    if ($config -match "onrender\.com") {
        Write-Host "✅ Render URL is already configured" -ForegroundColor Green
    } else {
        Write-Host "⚠️  No RecallBricks API URL found in config" -ForegroundColor Yellow
        Write-Host "You may need to add the environment variable manually:" -ForegroundColor Yellow
        Write-Host '  "RECALLBRICKS_API_URL": "https://recallbricks-api-clean.onrender.com"' -ForegroundColor Cyan
    }
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
