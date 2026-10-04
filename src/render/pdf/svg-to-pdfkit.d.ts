declare module 'svg-to-pdfkit' {
  interface SVGtoPDFOptions {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    assumePt?: boolean;
    fontCallback?: (family: string, bold: boolean, italic: boolean, fontOptions: unknown) => string;
  }
  export default function SVGtoPDF(
    doc: PDFKit.PDFDocument,
    svg: string,
    x?: number,
    y?: number,
    options?: SVGtoPDFOptions,
  ): void;
}
