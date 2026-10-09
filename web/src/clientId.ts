export function getWebClientId(): string {
  const key = "geoagent-web-client-id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}
