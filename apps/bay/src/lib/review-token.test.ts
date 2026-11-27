import { describe, it, expect } from 'vitest';
import { fragmentFormPath, readReviewToken } from './review-token';

// #122: the guest page reads the review token from the URL fragment, which browsers never send
// to a server, and still opens links minted before #122 in the /r/<token> path form.

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90011223344556677a';

describe('readReviewToken', () => {
  it('takes the token from the fragment', () => {
    expect(readReviewToken('/bay/r', `#${TOKEN}`)).toBe(TOKEN);
  });

  it('still reads a pre-#122 path-form link', () => {
    expect(readReviewToken(`/bay/r/${TOKEN}`, '')).toBe(TOKEN);
  });

  it('is empty when there is no token', () => {
    expect(readReviewToken('/bay/r', '')).toBe('');
  });
});

describe('fragmentFormPath', () => {
  it('rewrites a path-form link into the fragment form', () => {
    expect(fragmentFormPath(`/bay/r/${TOKEN}`, '', TOKEN)).toBe(`/bay/r#${TOKEN}`);
  });

  it('leaves a fragment-form link alone', () => {
    expect(fragmentFormPath('/bay/r', `#${TOKEN}`, TOKEN)).toBeNull();
  });
});
