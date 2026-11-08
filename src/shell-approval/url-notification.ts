const NOTIFICATION_TIMEOUT_MS = 3_000;
const NOTIFICATION_FAILURE = 'Shell approval notification failed.';

/**
 * POSTs `{title, body}` to a user-configured notification endpoint such as a Bark
 * `https://api.day.app/<device-key>` URL. The device key is part of the destination,
 * so every failure surfaces as one fixed message and never echoes URL, token or body.
 */
export async function sendApprovalNotification(
  url: string,
  notification: { readonly title: string; readonly body: string },
  signal?: AbortSignal,
): Promise<void> {
  if (url.length === 0) return;
  const timeout = AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: notification.title, body: notification.body }),
      redirect: 'error',
      signal: combined,
    });
  } catch {
    throw new Error(NOTIFICATION_FAILURE);
  }
  try {
    await response.body?.cancel();
  } catch {
    // The response body is discarded without parsing; release it when the peer still can.
  }
  if (!response.ok) throw new Error(NOTIFICATION_FAILURE);
}
