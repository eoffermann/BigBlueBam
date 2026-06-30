// Ambient type declarations for `assimpjs` (WASM Assimp), which ships no .d.ts.
// Standalone ambient module declaration (this file has no top-level import/export,
// so it is a global script and types the otherwise-untyped module rather than
// augmenting it). Covers only the surface bin-model-process.job.ts uses:
//   const ajs = await assimpjs();
//   const fl = new ajs.FileList(); fl.AddFile(name, bytes);
//   const r = ajs.ConvertFileList(fl, 'glb2');
//   if (r.IsSuccess()) r.GetFile(0).GetContent();
declare module 'assimpjs' {
  interface AjsFile {
    GetContent(): Uint8Array;
    GetPath?(): string;
  }
  interface AjsResult {
    IsSuccess(): boolean;
    GetErrorCode(): string;
    FileCount(): number;
    GetFile(index: number): AjsFile;
  }
  interface AjsFileList {
    AddFile(name: string, content: Uint8Array): void;
  }
  interface AssimpModule {
    FileList: new () => AjsFileList;
    ConvertFileList(fileList: AjsFileList, format: string): AjsResult;
  }
  export default function assimpjs(): Promise<AssimpModule>;
}
