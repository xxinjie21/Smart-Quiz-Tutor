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

  export const remote: {
    BrowserWindow: typeof BrowserWindow;
    dialog: {
      showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturn>;
    };
  };
}
