import { describe, it, expect } from 'vitest';
import { renderFormHtml } from '../src/lib/form-renderer.js';

// A form's custom_css is placed inside a <style> element on the public,
// server-rendered form page. The CSS sanitizers stripped url(), @import and
// friends but never `<`, so `</style>` closed the element and the rest ran as
// HTML for every visitor.

const form = (custom_css: string) =>
  ({
    id: 'f1',
    name: 'Survey',
    description: null,
    slug: 'survey',
    header_image_url: null,
    theme_color: null,
    custom_css,
    confirmation_type: 'message',
    confirmation_message: 'Thanks',
    confirmation_redirect_url: null,
    captcha_enabled: false,
    shuffle_fields: false,
    fields: [],
  }) as Parameters<typeof renderFormHtml>[0];

describe('renderFormHtml custom_css', () => {
  it.each([
    '</style><script>alert(document.cookie)</script><style>',
    '</STYLE ><img src=x onerror=alert(1)>',
    '</style\t><script>alert(1)</script>',
  ])('cannot close the style element: %s', (css) => {
    const html = renderFormHtml(form(css));
    const styleEnd = html.toLowerCase().indexOf('</style');
    const injected = html.indexOf(css);
    expect(injected).toBe(-1);
    // Exactly one style element, closed by the renderer's own tag.
    expect(html.toLowerCase().match(/<\/style/g)).toHaveLength(1);
    // What is left of the payload is inert CSS text: no raw `<` starts a tag.
    expect(html.slice(0, styleEnd)).not.toMatch(/<script|<img/i);
  });

  it('leaves ordinary CSS alone', () => {
    const css = '.title { color: #333; } .hint::after { content: "5 > 3"; }';
    expect(renderFormHtml(form(css))).toContain(css);
  });
});
