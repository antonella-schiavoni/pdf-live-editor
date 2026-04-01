export interface Annotation {
  id: string;
  page: number;
  x: number;
  y: number;
  width?: number; // Normalized width (0-1)
  text: string;
  fontSize: number;
  color: string;
  label?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export type DocumentType = 'general' | 'contract' | 'textbook' | 'research' | 'legal';

export interface PdfDocument {
  id: string;
  file?: File; // Optional if loading from cloud
  name: string;
  numPages: number;
  annotations: Annotation[];
  type: DocumentType;
  pdfUrl?: string; // For cloud storage
  ownerId?: string; // For cloud storage
  createdAt?: any; // For cloud storage
}
