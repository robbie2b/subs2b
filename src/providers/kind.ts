/** Native services (with their own integration in subs2b) versus Stremio addons imported by the user */
export const BUILTIN_PROVIDER_IDS: readonly string[] = ['opensubtitles', 'subdl', 'subsource', 'regielive', 'podnapisi'];

export type ProviderKind = 'service' | 'addon';

export function providerKind(id: string): ProviderKind {
  return BUILTIN_PROVIDER_IDS.includes(id) ? 'service' : 'addon';
}
