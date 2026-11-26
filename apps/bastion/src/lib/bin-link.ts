// Turn what a person pastes into the Evidence locker's "file from Bin" field into a Bin asset id
// (#219). The parsing lives in @bigbluebam/shared (suite-links.ts) with the Bolt and Beacon link
// readers (#232, #239), so every "paste the link" field in Bastion reads links the same way.

import { SUITE_LINK_REFUSAL, suiteLinkId } from '@bigbluebam/shared';

export const NOT_A_BIN_LINK = SUITE_LINK_REFUSAL.bin;

/** The asset id in a pasted Bin link or bare id, or null when there is none. */
export function binAssetIdFrom(input: string): string | null {
  return suiteLinkId(input, 'bin');
}
