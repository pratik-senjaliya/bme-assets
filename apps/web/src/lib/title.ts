import { useEffect } from 'react';

// The most recent caller owns the title (a result shown under a page header, like the import's "done" step, wins),
// so two keepers never take turns rewriting it.
let seq = 0;
let owner = 0;

// Sets the browser tab title for as long as the page is shown. Next.js writes the layout's default title into
// <head> as well, and it can arrive after the page has set its own (streamed metadata), so the owner puts it back
// whenever something else changes it.
export function useDocumentTitle(title: string) {
  useEffect(() => {
    if (!title) return;
    const id = ++seq;
    owner = id;
    document.title = title;
    const keep = new MutationObserver(() => {
      if (owner === id && document.title !== title) document.title = title;
    });
    keep.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      keep.disconnect();
      if (owner === id) owner = 0;
    };
  }, [title]);
}
