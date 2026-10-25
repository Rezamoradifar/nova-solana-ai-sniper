/**
 * navigator.clipboard.writeText requires a secure context (HTTPS or
 * localhost) — falls back to the classic textarea + execCommand('copy')
 * trick for plain-HTTP deployments or older iOS Safari, so Copy Address
 * still has a legacy path when the browser permits it. Callers must show
 * a manual-copy option when both APIs are denied.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const el = document.createElement('textarea');
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el.value = text;
  el.readOnly = true;
  el.style.position = 'fixed';
  el.style.fontSize = '16px';
  el.style.top = '0';
  el.style.left = '0';
  el.style.opacity = '0';
  document.body.appendChild(el);
  let ok = false;
  try {
    el.focus({ preventScroll: true });
    el.select();
    el.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    el.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
  return ok;
}
