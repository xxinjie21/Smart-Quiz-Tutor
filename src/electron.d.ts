declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}

declare module "electron" {
  interface BrowserWindowConstructorOptions {
    show?: boolean;
    width?: number;
    height?: number;
    webPreferences?: Record<string, unknown>;
  }

  interface PDFOptions {
    printBackground?: boolean;
    pageSize?: string;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
  }

  class BrowserWindow {
    constructor(options: BrowserWindowConstructorOptions);
    loadURL(url: string): Promise<void>;
    loadFile(filePath: string): Promise<void>;
    webContents: {
      printToPDF(options: PDFOptions): Promise<Buffer>;
    };
    close(): void;
  }

  interface SaveDialogOptions {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }

  interface SaveDialogReturn {
    canceled: boolean;
    filePath?: string;
  }

  /** `shell` 在渲染进程通常由 `@electron/remote` 提供，因此可能缺失。 */
  interface Shell {
    trashItem(fullPath: string): Promise<void>;
  }

  export const remote: {
    BrowserWindow: typeof BrowserWindow;
    dialog: {
      showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturn>;
    };
    shell?: Shell;
  };

  export const shell: Shell | undefined;
}
