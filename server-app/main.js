const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    resizable: false,
    title: 'PhotoSync Server'
  });

  mainWindow.loadFile('index.html');
}

function startServer() {
  const serverDir = path.join(__dirname, '..', 'server');
  serverProcess = spawn('node', ['server.js'], {
    cwd: serverDir,
    stdio: 'pipe'
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server: ${data}`);
    if (mainWindow) {
      mainWindow.webContents.send('server-log', data.toString());
    }
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server Error: ${data}`);
    if (mainWindow) {
      mainWindow.webContents.send('server-error', data.toString());
    }
  });

  serverProcess.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.whenReady().then(() => {
  createWindow();
  startServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopServer();
});

// IPC handlers
ipcMain.handle('open-uploads-folder', () => {
  const uploadsPath = path.join(__dirname, '..', 'server', 'uploads');
  shell.openPath(uploadsPath);
});

ipcMain.handle('get-server-info', () => {
  const networkInterfaces = os.networkInterfaces();
  let ipAddress = 'localhost';
  
  // Find local IP
  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ipAddress = net.address;
        break;
      }
    }
  }

  return {
    ip: ipAddress,
    port: 3000,
    url: `http://${ipAddress}:3000`
  };
});

ipcMain.handle('restart-server', () => {
  stopServer();
  setTimeout(() => {
    startServer();
  }, 1000);
});
