export interface ApiFormat {
  type: string;
  subtype?: string;
}

export type ApiAccess = string | ApiFormat;

export function canonicalizeApiAccessKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (normalized === 'images') return 'openai-images';
  if (normalized === 'openrouter') return 'openrouter-images';
  return normalized;
}

export function apiAccessToKey(access: ApiAccess): string {
  if (typeof access === 'string') return canonicalizeApiAccessKey(access);

  const type = access.type.trim().toLowerCase();
  const subtype = access.subtype?.trim().toLowerCase();
  return subtype ? `${type}:${subtype}` : canonicalizeApiAccessKey(type);
}

export function normalizeApiAccessList(access: readonly ApiAccess[] | undefined): string[] {
  if (!access) return [];
  return access.map(apiAccessToKey).filter(Boolean);
}

export function getApiBaseType(apiType: string): string {
  return apiType.trim().toLowerCase().split(':', 1)[0] || '';
}

export function getApiSubtype(apiType: string): string | undefined {
  const normalized = apiType.trim().toLowerCase();
  const separator = normalized.indexOf(':');
  return separator === -1 ? undefined : normalized.slice(separator + 1) || undefined;
}

export function isApiSubtype(apiType: string | undefined): boolean {
  return !!apiType && getApiSubtype(apiType) !== undefined;
}
