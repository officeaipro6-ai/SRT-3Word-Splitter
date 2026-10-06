import { contextBridge, ipcRenderer } from 'electron';

interface SaveFileOptions {
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
}

interface SaveFileResult {
  canceled: boolean;
  filePath?: string;
}

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (options: SaveFileOptions): Promise<SaveFileResult> =>
    ipcRenderer.invoke('dialog:saveFile', options),

  getVersion: (): Promise<string> =>
    ipcRenderer.invoke('app:getVersion'),

  quit: (): Promise<void> =>
    ipcRenderer.invoke('app:quit'),
});

contextBridge.exposeInMainWorld('isElectron', true);