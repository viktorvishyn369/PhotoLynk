# PhotoSync Server - One-Line Installer for Windows
# Usage: irm https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.ps1 | iex

Write-Host "╔════════════════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║           PhotoSync Server - Installer            ║" -ForegroundColor Blue
Write-Host "╚════════════════════════════════════════════════════╝" -ForegroundColor Blue
Write-Host ""

# Headless/non-interactive mode:
# - Default is non-interactive (best for one-line installers)
# - Set PHOTOSYNC_INTERACTIVE=1 to allow tray UI and Read-Host pauses
$interactive = $env:PHOTOSYNC_INTERACTIVE -eq "1"
$headless = -not $interactive
if ($headless) {
    Write-Host "⚠  Headless mode enabled (no tray UI)" -ForegroundColor Yellow
    Write-Host ""
}

function Stop-PortListeners {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($pid in $pids) {
                if ($pid -and $pid -ne 0) {
                    Write-Host "⚠  Port $Port is in use. Stopping process $pid" -ForegroundColor Yellow
                    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {
        # ignore
    }
}

# Allow this process to run npm.ps1 and other helper scripts without changing system-wide policy
try {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "⚠  Could not change execution policy for this session. If you see npm.ps1 policy errors, run PowerShell as Administrator and try again." -ForegroundColor Yellow
}

# Check if Node.js is installed
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Blue
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "⚠  Node.js not found. Installing..." -ForegroundColor Yellow

    # Helper: are we running as Administrator?
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    # Check if winget is available (Windows 10/11)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "→ Using winget to install Node.js LTS" -ForegroundColor Blue
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    }
    # Else, if Chocolatey is already available, use it
    elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "→ Using Chocolatey to install Node.js LTS" -ForegroundColor Blue
        choco install nodejs-lts -y
    }
    # Else, try to install Chocolatey if we are admin
    elseif ($isAdmin) {
        Write-Host "→ Chocolatey not found. Installing Chocolatey first..." -ForegroundColor Blue
        try {
            Set-ExecutionPolicy Bypass -Scope Process -Force | Out-Null
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
            Write-Host "✓ Chocolatey installed" -ForegroundColor Green
            # Refresh PATH so choco is available
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "→ Using Chocolatey to install Node.js LTS" -ForegroundColor Blue
            choco install nodejs-lts -y
        } catch {
            Write-Host "✗ Failed to install Chocolatey automatically" -ForegroundColor Red
        }
    }
    
    # Final fallback if nothing worked
    if (!(Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "✗ Could not install Node.js automatically" -ForegroundColor Red
        if (-not $isAdmin) {
            Write-Host "This script is not running as Administrator. To let it install Chocolatey + Node.js automatically:" -ForegroundColor Yellow
            Write-Host "  1) Close this window" -ForegroundColor Yellow
            Write-Host "  2) Right-click PowerShell and choose 'Run as administrator'" -ForegroundColor Yellow
            Write-Host "  3) Run the install command again" -ForegroundColor Yellow
        }
        Write-Host "" 
        # Suggest architecture-specific Node.js 24.11.1 MSI
        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($arch -eq "ARM64") {
            $nodeUrl = "https://nodejs.org/dist/v24.11.1/node-v24.11.1-arm64.msi"
        } else {
            # Default to x64 build
            $nodeUrl = "https://nodejs.org/dist/v24.11.1/node-v24.11.1-x64.msi"
        }
        Write-Host "Opening Node.js v24.11.1 installer in your default browser (detected architecture: $arch):" -ForegroundColor Yellow
        Write-Host "  $nodeUrl" -ForegroundColor Yellow
        try {
            Start-Process $nodeUrl
        } catch {
            Write-Host "(If the browser did not open, manually visit: $nodeUrl)" -ForegroundColor Yellow
        }
        Write-Host "" 
        Write-Host "In your browser (for architecture $arch):" -ForegroundColor Yellow
        Write-Host "  1) Download the matching Windows LTS installer (.msi)" -ForegroundColor Yellow
        Write-Host "  2) Run it and complete the setup" -ForegroundColor Yellow
        Write-Host "  3) Close this window and run this installer command again" -ForegroundColor Yellow
        Write-Host "" 
        if ($interactive) { Read-Host "Press Enter to close this window" }
        exit 1
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Host "✓ Node.js installed" -ForegroundColor Green
} else {
    $nodeVersion = node --version
    Write-Host "✓ Node.js found: $nodeVersion" -ForegroundColor Green
}

# Check if Git is installed
Write-Host ""
Write-Host "[2/5] Checking Git..." -ForegroundColor Blue
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "⚠  Git not found. Installing..." -ForegroundColor Yellow
    
    $gitInstalled = $false

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "→ Using winget to install Git" -ForegroundColor Blue
        winget install Git.Git --accept-package-agreements --accept-source-agreements
        $gitInstalled = (Get-Command git -ErrorAction SilentlyContinue) -ne $null
    }
    elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "→ Using Chocolatey to install Git" -ForegroundColor Blue
        choco install git -y
        $gitInstalled = (Get-Command git -ErrorAction SilentlyContinue) -ne $null
    }

    if (-not $gitInstalled) {
        Write-Host "✗ Could not install Git automatically" -ForegroundColor Red
        # Suggest architecture-specific Git-for-Windows installer
        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($arch -eq "ARM64") {
            $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/Git-2.52.0-arm64.exe"
        } else {
            # Default to x64 build
            $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/Git-2.52.0-64-bit.exe"
        }
        Write-Host "Opening Git for Windows installer in your default browser (detected architecture: $arch):" -ForegroundColor Yellow
        Write-Host "  $gitUrl" -ForegroundColor Yellow
        try {
            Start-Process $gitUrl
        } catch {
            Write-Host "(If the browser did not open, manually visit: $gitUrl)" -ForegroundColor Yellow
        }
        Write-Host "" 
        Write-Host "In your browser (for architecture $arch):" -ForegroundColor Yellow
        Write-Host "  1) Download and run the Git for Windows installer" -ForegroundColor Yellow
        Write-Host "  2) Accept the defaults to add Git to PATH" -ForegroundColor Yellow
        Write-Host "  3) Close this window and run this installer command again" -ForegroundColor Yellow
        Write-Host "" 
        if ($interactive) { Read-Host "Press Enter to close this window" }
        exit 1
    }
    
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Host "✓ Git installed" -ForegroundColor Green
} else {
    Write-Host "✓ Git found" -ForegroundColor Green
}

# Clone repository
Write-Host ""
Write-Host "[3/5] Downloading PhotoSync..." -ForegroundColor Blue
$installDir = "$env:USERPROFILE\PhotoSync"

if (Test-Path $installDir) {
    Write-Host "⚠  PhotoSync directory exists, updating..." -ForegroundColor Yellow
    Set-Location $installDir
    git pull
} else {
    try {
        git clone https://github.com/viktorvishyn369/PhotoSync.git $installDir
    } catch {
        Write-Host "✗ Failed to clone repository from GitHub" -ForegroundColor Red
        Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "" 
        Write-Host "Please check that this machine can reach https://github.com in a browser and that DNS/network are working, then run this installer again." -ForegroundColor Yellow
        if ($interactive) { Read-Host "Press Enter to close this window" }
        exit 1
    }
    Set-Location $installDir
}
Write-Host "✓ Downloaded to $installDir" -ForegroundColor Green

# Install server dependencies
Write-Host ""
Write-Host "[4/5] Installing server dependencies..." -ForegroundColor Blue
Set-Location server
# Use cmd.exe to run npm so we do not depend on npm.ps1 and execution policy
cmd /c "npm install --production"
Write-Host "✓ Server dependencies installed" -ForegroundColor Green

# Install tray dependencies
Write-Host ""
Write-Host "[5/5] Installing tray app dependencies..." -ForegroundColor Blue
Set-Location ..\server-tray

if ($headless) {
    Write-Host "⚠  Headless mode: skipping tray app install" -ForegroundColor Yellow
} else {
    cmd /c "npm install"
    Write-Host "✓ Tray app dependencies installed" -ForegroundColor Green
}

# Free Expo ports (prevents Metro conflicts if user starts Expo later)
Stop-PortListeners -Port 8081
Stop-PortListeners -Port 8082

# Start the tray app (or server headless)
Write-Host ""
Write-Host "✓ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Blue
Write-Host "PhotoSync Server is starting..." -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Blue
Write-Host ""
Write-Host "Look for the PhotoSync icon in your system tray (bottom-right)"
Write-Host ""
Write-Host "Click the icon to:"
Write-Host "  • Open files location"
Write-Host "  • Stop/Start/Restart server"
Write-Host "  • Quit"
Write-Host ""

# Try to detect a useful local IPv4 address for the server URL
try {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1 -ExpandProperty IPAddress)
} catch {
    $ip = $null
}

if ($ip) {
    Write-Host "Server URL: http://$ip:3000"
} else {
    Write-Host "Server URL: http://YOUR_LOCAL_IP:3000"
    Write-Host "(Could not auto-detect IP; run 'ipconfig' to find it.)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Note: Find your local IP with: ipconfig" -ForegroundColor Yellow
Write-Host ""

if ($headless) {
    Write-Host "→ Starting server headlessly..." -ForegroundColor Blue
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "$installDir\server" -WindowStyle Hidden
    Write-Host "✓ Server started (headless)" -ForegroundColor Green
    exit 0
} else {
    # Start the tray app via cmd so execution policy on npm.ps1 is irrelevant
    cmd /c "npm start"

    # Keep window open so user can read any errors
    Write-Host "" 
    Write-Host "Installation script finished. If you saw any errors above, please screenshot or copy them before closing." -ForegroundColor Yellow
    if ($interactive) { Read-Host "Press Enter to close this window" }
}
