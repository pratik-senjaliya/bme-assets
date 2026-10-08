import { MAX_UPLOAD_BYTES, type AttachmentOwnerType, type AttachmentRow } from '@bme/shared';
import { api } from '@/lib/api';

export const ACCEPT = '.pdf,.jpg,.jpeg,.png';

// Short names for the document types, used wherever a document is listed.
export const KIND_LABEL: Record<string, string> = {
  po: 'Purchase order',
  installation_report: 'Installation report',
  photo: 'Photo',
  manual: 'Manual',
  certificate: 'Certificate',
  eol_letter: 'End-of-life letter',
  contract: 'Contract copy',
  service_report: 'Service report',
  invoice: 'Invoice / bill',
  condemnation_form: 'Condemnation form',
  other: 'Other',
};

// null = fine, otherwise the plain-language reason the browser can already tell (the server checks again).
export const fileProblem = (f: File) => (f.size > MAX_UPLOAD_BYTES ? `${f.name} is over 10 MB` : /\.(pdf|jpe?g|png)$/i.test(f.name) ? null : `${f.name}: only PDF, JPG and PNG files are allowed`);

export async function uploadFile(file: File, owner: { ownerType: AttachmentOwnerType; ownerId: string }, kind: string) {
  const body = new FormData();
  body.set('ownerType', owner.ownerType);
  body.set('ownerId', owner.ownerId);
  body.set('kind', kind);
  body.set('file', file);
  return api<AttachmentRow>('/attachments', { body });
}

// Uploads a batch one by one (the record already exists). Returns the names that failed, so the caller can say so.
export async function uploadAll(files: File[], owner: { ownerType: AttachmentOwnerType; ownerId: string }, kindOf: (f: File) => string) {
  const failed: string[] = [];
  for (const f of files) {
    try {
      await uploadFile(f, owner, kindOf(f));
    } catch {
      failed.push(f.name);
    }
  }
  return failed;
}
