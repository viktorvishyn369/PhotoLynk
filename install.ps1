# PhotoSync Server - One-Line Installer for Windows
# Usage: irm https://raw.githubusercontent.com/viktorvishyn369/PhotoSync/main/install.ps1 | iex

Write-Host "╔════════════════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║           PhotoSync Server - Installer            ║" -ForegroundColor Blue
Write-Host "╚════════════════════════════════════════════════════╝" -ForegroundColor Blue
Write-Host ""

# Check if Node.js is installed
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Blue
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "⚠  Node.js not found. Installing..." -ForegroundColor Yellow

    # Helper: are we running as Administrator?
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    # Check if winget is available (Windows 10/11)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "→ Using winget to install Node.js LTS" -ForegroundColor Blue
        winget install OpenJS.NodeJS.LTS
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
        $nodeUrl = "https://nodejs.org/en/download"
        Write-Host "Opening Node.js LTS download page in your default browser:" -ForegroundColor Yellow
        Write-Host "  $nodeUrl" -ForegroundColor Yellow
        try {
            Start-Process $nodeUrl
        } catch {
            Write-Host "(If the browser did not open, manually visit: $nodeUrl)" -ForegroundColor Yellow
        }
        Write-Host "" 
        Write-Host "In your browser:" -ForegroundColor Yellow
        Write-Host "  1) Download the Windows LTS installer (.msi)" -ForegroundColor Yellow
        Write-Host "  2) Run it and complete the setup" -ForegroundColor Yellow
        Write-Host "  3) Close this window and run this installer command again" -ForegroundColor Yellow
        Write-Host "" 
        Read-Host "Press Enter to close this window"
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
    
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Git.Git
    }
    elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install git -y
    }
    else {
        Write-Host "✗ Could not install Git automatically" -ForegroundColor Red
        Write-Host "Please install Git from: https://git-scm.com/" -ForegroundColor Yellow
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
    git clone https://github.com/viktorvishyn369/PhotoSync.git $installDir
    Set-Location $installDir
}
Write-Host "✓ Downloaded to $installDir" -ForegroundColor Green

# Install server dependencies
Write-Host ""
Write-Host "[4/5] Installing server dependencies..." -ForegroundColor Blue
Set-Location server
npm install --production
Write-Host "✓ Server dependencies installed" -ForegroundColor Green

# Install tray dependencies
Write-Host ""
Write-Host "[5/5] Installing tray app dependencies..." -ForegroundColor Blue
Set-Location ..\server-tray
npm install
Write-Host "✓ Tray app dependencies installed" -ForegroundColor Green

# Start the tray app
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
Write-Host "Server URL: http://YOUR_LOCAL_IP:3000"
Write-Host ""
Write-Host "Note: Find your local IP with: ipconfig" -ForegroundColor Yellow
Write-Host ""

# Start the app
npm start

# Keep window open so user can read any errors
Write-Host "" 
Write-Host "Installation script finished. If you saw any errors above, please screenshot or copy them before closing." -ForegroundColor Yellow
Read-Host "Press Enter to close this window"
