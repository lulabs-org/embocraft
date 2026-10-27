export function originAllowed(
  origin: string | undefined,
  allowed: string,
  required = true,
) {
  if (allowed === '*' || origin === allowed || (!required && !origin))
    return true;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false;
    // Local development uses both names for the same IPv4 loopback service.
    // Keep the configured scheme and port boundary intact.
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    else if (url.hostname === '127.0.0.1') url.hostname = 'localhost';
    else return false;
    return url.origin === allowed;
  } catch {
    return false;
  }
}
