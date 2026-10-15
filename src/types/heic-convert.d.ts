declare module "heic-convert" {
  export default function convert(args: {
    buffer: Uint8Array | ArrayBuffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }): Promise<ArrayBuffer>;
}
