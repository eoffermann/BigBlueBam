import type { CalendarProvider } from './types.js';
import { IcsCalendarProvider } from './ics-provider.js';
import { GoogleCalendarProvider, MicrosoftCalendarProvider } from './oauth-providers.js';

export * from './types.js';
export { parseIcs } from './ics-parser.js';

/** Provider registry. Adding a new external source = add one entry here. */
const PROVIDERS: Record<string, () => CalendarProvider> = {
  ics: () => new IcsCalendarProvider(),
  google: () => new GoogleCalendarProvider(),
  microsoft: () => new MicrosoftCalendarProvider(),
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

/** Provider keys that work today with no operator OAuth credentials. */
export const NO_SECRET_PROVIDERS = ['ics'];

export function resolveProvider(provider: string): CalendarProvider | null {
  const factory = PROVIDERS[provider];
  return factory ? factory() : null;
}
