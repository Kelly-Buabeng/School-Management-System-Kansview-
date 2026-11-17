export interface UploadPolicy {
  allowedTypes: Array<'image/jpeg' | 'image/png' | 'application/pdf' | 'text/csv' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'>;
  maxBytes: number;
  /** Re-encode images (strips EXIF/GPS) and cap dimensions. */
  reencodeImages?: { maxWidth: number; maxHeight: number };
}

export interface IncomingFile {
  originalName: string;
  buffer: Buffer;
  declaredMimeType?: string;
}

export interface AcceptedFile {
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: 'pending' | 'clean' | 'infected' | 'error';
}

/** Validates (magic bytes, size), sanitises, stores via FileStore, queues malware scan. Real implementation: Agent D. */
export interface UploadPipeline {
  accept(file: IncomingFile, policy: UploadPolicy, uploadedBy: string): Promise<AcceptedFile>;
}
export const UPLOAD_PIPELINE = Symbol('UPLOAD_PIPELINE');

export const UPLOAD_POLICIES = {
  studentDocument: { allowedTypes: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024, reencodeImages: { maxWidth: 2400, maxHeight: 2400 } },
  passportPhoto: { allowedTypes: ['image/jpeg', 'image/png'], maxBytes: 2 * 1024 * 1024, reencodeImages: { maxWidth: 600, maxHeight: 800 } },
  paymentEvidence: { allowedTypes: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024, reencodeImages: { maxWidth: 2000, maxHeight: 2000 } },
  logo: { allowedTypes: ['image/png', 'image/jpeg'], maxBytes: 1024 * 1024, reencodeImages: { maxWidth: 800, maxHeight: 800 } },
  importFile: { allowedTypes: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], maxBytes: 10 * 1024 * 1024 },
} satisfies Record<string, UploadPolicy>;
