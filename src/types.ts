export interface Annotation {
  id: string;
  page: number;
  x: number;
  y: number;
  width?: number; // Normalized width (0-1)
  text: string;
  fontSize: number;
  color: string;
}

export interface PdfDocument {
  file: File;
  name: string;
  numPages: number;
  annotations: Annotation[];
}
