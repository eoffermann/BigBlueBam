import { describe, expect, it } from 'vitest';
import { binAssetIdFrom } from '@/lib/bin-link';

// The Evidence locker's "file from Bin" field (#219): a pasted Bin link or a bare id becomes the
// asset id; anything else is null (the page shows plain words).

const ID = '3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('binAssetIdFrom', () => {
  it('reads the asset id out of a Bin asset link (absolute or relative, any case, trailing slash)', () => {
    expect(binAssetIdFrom(`https://bigbluebam.example/bin/assets/${ID}`)).toBe(ID);
    expect(binAssetIdFrom(`  https://bigbluebam.example/bin/assets/${ID.toUpperCase()}/  `)).toBe(ID);
    expect(binAssetIdFrom(`/bin/assets/${ID}`)).toBe(ID);
    expect(binAssetIdFrom(`https://host/bin/assets/${ID}?tab=versions#top`)).toBe(ID);
  });

  it('accepts a bare id and a Bin link that names the asset in its query', () => {
    expect(binAssetIdFrom(ID)).toBe(ID);
    expect(binAssetIdFrom(`https://host/bin/?asset=${ID}`)).toBe(ID);
  });

  it('refuses anything that is not a Bin file link', () => {
    for (const bad of ['', '   ', 'report.pdf', 'https://drive.example/file/abc', `https://host/brief/docs/${ID}`, `https://host/bin/assets/not-an-id`]) {
      expect(binAssetIdFrom(bad), bad).toBeNull();
    }
  });
});
