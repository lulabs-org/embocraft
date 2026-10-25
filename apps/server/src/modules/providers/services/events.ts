export const PROVIDERS_CHANGED = 'providers.changed' as const;

export type ProviderChangedEvent = {
  type: typeof PROVIDERS_CHANGED;
  providerId: string;
};

export type ProviderEventPublisher = (event: ProviderChangedEvent) => void;
