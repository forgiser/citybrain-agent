export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = await response.json().catch(() => undefined) as
    | { error?: string }
    | undefined;
  if (!response.ok) throw new Error(data?.error ?? `${response.status} ${response.statusText}`);
  return data as T;
}

