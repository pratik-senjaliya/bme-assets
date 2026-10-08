// Downloads a file from the API (same origin, cookie sent). Errors come back as the API's own plain-language
// message instead of a page of JSON in a new tab.
import { notifySignedOut } from '@/lib/nav';

export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api/v1${path}`);
  if (res.status === 401) notifySignedOut();
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error?.message ?? 'Could not download the file');
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
