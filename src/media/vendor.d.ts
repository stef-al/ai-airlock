// tesseract.js-core ships an Emscripten UMD module without types.
declare module 'tesseract.js-core/tesseract-core-simd-lstm.js' {
  interface TessFS {
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string, opts?: { encoding: 'utf8' }): Uint8Array | string;
    unlink(path: string): void;
  }
  export interface TessBaseAPI {
    Init(datapath: string | null, langs: string, oem: number, config?: string): number;
    SetVariable(name: string, value: string): boolean;
    SetImageFile(exifOrientation: number, angle: number): number;
    Recognize(monitor: null): number;
    GetUTF8Text(): string;
    GetJSONText(): string;
    MeanTextConf(): number;
    Clear(): void;
    End(): void;
  }
  export interface TessModule {
    FS: TessFS;
    TessBaseAPI: new () => TessBaseAPI;
  }
  const TesseractCore: (opts: { wasmBinary: Uint8Array; print?: (s: string) => void; printErr?: (s: string) => void; TesseractProgress?: (p: number) => void }) => Promise<TessModule>;
  export default TesseractCore;
}
