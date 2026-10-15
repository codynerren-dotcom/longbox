export {};

declare global {
  interface BarcodeDetector {
    detect(source: CanvasImageSource): Promise<Array<{ rawValue: string; format: string }>>;
  }

  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): BarcodeDetector;
    };
  }
}
