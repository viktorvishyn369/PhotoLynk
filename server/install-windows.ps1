# PhotoSync Server - Windows Installation Script
# Automatically installs as Windows Service with auto-restart

# Requires Administrator privileges
#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

Write-Host "╔════════════════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║     PhotoSync Server - Windows Installation       ║" -ForegroundColor Blue
Write-Host "╚════════════════════════════════════════════════════╝" -ForegroundColor Blue
Write-Host ""

# Step 1: Check Node.js
Write-Host "[1/7] Checking Node.js installation..." -ForegroundColor Blue
try {
    $nodeVersion = node -v
    $versionNumber = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($versionNumber -lt 16) {
        Write-Host "❌ Node.js version too old (need 16+)" -ForegroundColor Red
        Write-Host "Download from: https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "✓ Node.js found: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js not found. Please install Node.js first:" -ForegroundColor Red
    Write-Host "   Visit: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Step 2: Install dependencies
Write-Host ""
Write-Host "[2/7] Installing npm dependencies..." -ForegroundColor Blue
npm install --production
Write-Host "✓ Dependencies installed" -ForegroundColor Green

# Step 3: Create uploads directory
Write-Host ""
Write-Host "[3/7] Creating uploads directory..." -ForegroundColor Blue
if (!(Test-Path "uploads")) {
    New-Item -ItemType Directory -Path "uploads" | Out-Null
}
Write-Host "✓ Uploads directory ready" -ForegroundColor Green

# Step 4: Get server IP
Write-Host ""
Write-Host "[4/7] Detecting server IP addresses..." -ForegroundColor Blue
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254.*"} | Select-Object -First 1).IPAddress
try {
    $publicIP = (Invoke-WebRequest -Uri "https://ifconfig.me" -UseBasicParsing -TimeoutSec 5).Content
} catch {
    $publicIP = "Unable to detect"
}

Write-Host "✓ Local IP: $localIP" -ForegroundColor Green
if ($publicIP -ne "Unable to detect") {
    Write-Host "✓ Public IP: $publicIP" -ForegroundColor Green
}

# Step 5: Configure Windows Firewall
Write-Host ""
Write-Host "[5/7] Configuring Windows Firewall..." -ForegroundColor Blue

$ruleName = "PhotoSync Server - Port 3000"
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($existingRule) {
    Write-Host "Firewall rule already exists, updating..." -ForegroundColor Yellow
    Remove-NetFirewallRule -DisplayName $ruleName
}

New-NetFirewallRule -DisplayName $ruleName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 3000 `
    -Action Allow `
    -Profile Any `
    -Description "Allow PhotoSync Server on port 3000" | Out-Null

Write-Host "✓ Windows Firewall: Port 3000 opened" -ForegroundColor Green

# Step 6: Install node-windows for service management
Write-Host ""
Write-Host "[6/7] Installing Windows Service manager..." -ForegroundColor Blue
npm install -g node-windows
Write-Host "✓ node-windows installed" -ForegroundColor Green

# Step 7: Create Windows Service
Write-Host ""
Write-Host "[7/7] Creating Windows Service..." -ForegroundColor Blue

$installDir = Get-Location
$serviceScript = @"
var Service = require('node-windows').Service;

// Create a new service object
var svc = new Service({
  name: 'PhotoSync Server',
  description: 'PhotoSync - Decentralized Photo Backup Server',
  script: '$installDir\\server.js',
  nodeOptions: [
    '--harmony',
    '--max_old_space_size=512'
  ],
  env: [
    {
      name: 'NODE_ENV',
      value: 'production'
    },
    {
      name: 'PORT',
      value: '3000'
    }
  ],
  workingDirectory: '$installDir',
  allowServiceLogon: true,
  maxRestarts: 10,
  maxRetries: 5,
  wait: 10,
  grow: 0.5,
  abortOnError: false
});

// Listen for the "install" event
svc.on('install', function() {
  console.log('Service installed successfully!');
  svc.start();
});

svc.on('alreadyinstalled', function() {
  console.log('Service already installed. Restarting...');
  svc.restart();
});

svc.on('start', function() {
  console.log('Service started!');
});

svc.on('error', function(err) {
  console.error('Service error:', err);
});

// Install the service
svc.install();
"@

$serviceScript | Out-File -FilePath "install-service.js" -Encoding UTF8

# Run the service installer
node install-service.js

# Wait for service to start
Start-Sleep -Seconds 3

# Check service status
$service = Get-Service -Name "PhotoSync Server" -ErrorAction SilentlyContinue
if ($service -and $service.Status -eq "Running") {
    Write-Host "✓ Service started successfully" -ForegroundColor Green
} else {
    Write-Host "❌ Service failed to start" -ForegroundColor Red
    Write-Host "Check Event Viewer for details" -ForegroundColor Yellow
    exit 1
}

# Cleanup
Remove-Item "install-service.js" -ErrorAction SilentlyContinue

# Display information
Write-Host ""
Write-Host "╔════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║            Installation Successful! 🎉             ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "📱 Mobile App Configuration:" -ForegroundColor Blue
Write-Host ""
Write-Host "   Local Network:" -ForegroundColor Yellow
Write-Host "   • Server IP: $localIP:3000" -ForegroundColor Green
Write-Host "   • Use this when on the same network"
Write-Host ""
if ($publicIP -ne "Unable to detect") {
    Write-Host "   Remote Access:" -ForegroundColor Yellow
    Write-Host "   • Server IP: $publicIP:3000" -ForegroundColor Green
    Write-Host "   • Use this from anywhere (requires port forwarding)"
    Write-Host ""
}
Write-Host "🔥 Firewall:" -ForegroundColor Blue
Write-Host "   • Port 3000 is OPEN on Windows Firewall" -ForegroundColor Green
Write-Host ""
Write-Host "🔧 Service Management:" -ForegroundColor Blue
Write-Host "   • Status:  Get-Service 'PhotoSync Server'" -ForegroundColor Green
Write-Host "   • Stop:    Stop-Service 'PhotoSync Server'" -ForegroundColor Yellow
Write-Host "   • Start:   Start-Service 'PhotoSync Server'" -ForegroundColor Green
Write-Host "   • Restart: Restart-Service 'PhotoSync Server'" -ForegroundColor Yellow
Write-Host "   • Logs:    Check Event Viewer → Windows Logs → Application" -ForegroundColor Blue
Write-Host ""
Write-Host "🔄 Auto-Restart:" -ForegroundColor Blue
Write-Host "   • Service will automatically restart if it crashes" -ForegroundColor Green
Write-Host "   • Restart delay: 10 seconds"
Write-Host "   • Starts on boot: ENABLED" -ForegroundColor Green
Write-Host ""
Write-Host "✓ Server is running at: http://$localIP:3000" -ForegroundColor Green
Write-Host ""
