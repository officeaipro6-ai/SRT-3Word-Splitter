import { app, BrowserWindow, ipcMain, shell, dialog, protocol } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const isDev = !app.isPackaged;
const preloadPath = join(__dirname, 'preload.js');
const indexHtmlPath = join(__dirname, '..', 'dist', 'index.html');

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    title: 'Odia SRT — Audio/Video → Tagged SRT',
    icon: join(__dirname, '..', 'public', 'icons', 'icon-512.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
    show: false,
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    if (existsSync(indexHtmlPath)) {
      win.loadFile(indexHtmlPath);
    } else {
      console.error('Built index.html not found at:', indexHtmlPath);
      app.quit();
    }
  }

  return win;
}

app.whenReady().then(() => {
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('dialog:saveFile', async (_event, options: {
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
}) => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('app:quit', () => app.quit());

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (e, url) => {
    const parsed = new URL(url);
    if (parsed.origin !== 'http://localhost:5173' && !url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
});

if (isDev) {
  import('electron-reload').then((reload) => {
    reload(__dirname, {
      electron: join(__dirname, '..', 'node_modules', '.bin', 'electron' + (process.platform === 'win32' ? '.cmd' : '')),
      hardResetMethod: 'exit',
    });
  }).catch(() => {});
}