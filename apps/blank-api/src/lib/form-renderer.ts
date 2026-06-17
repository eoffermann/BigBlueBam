/**
 * Server-side HTML renderer for public Blank forms.
 *
 * Generates a self-contained, responsive HTML page with inline styles and
 * vanilla JS — no external dependencies. The page POSTs submissions via
 * fetch and displays the configured confirmation message on success.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormField {
  id: string;
  field_key: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  field_type: string;
  required: boolean;
  min_length: number | null;
  max_length: number | null;
  min_value: string | null;
  max_value: string | null;
  regex_pattern: string | null;
  options: unknown;
  scale_min: number | null;
  scale_max: number | null;
  scale_min_label: string | null;
  scale_max_label: string | null;
  allowed_file_types: string[] | null;
  max_file_size_mb: number | null;
  sort_order: number;
  page_number: number;
  column_span: number;
  default_value: string | null;
}

interface FormData {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  header_image_url: string | null;
  theme_color: string | null;
  custom_css: string | null;
  confirmation_type: string;
  confirmation_message: string | null;
  confirmation_redirect_url: string | null;
  captcha_enabled: boolean;
  shuffle_fields: boolean;
  fields: FormField[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderFormHtml(form: FormData): string {
  const theme = form.theme_color ?? '#3b82f6';
  const fields = maybeShuffleFields(form.fields, form.shuffle_fields);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(form.name)}</title>
<style>
${BASE_CSS}
:root { --theme: ${esc(theme)}; --theme-hover: ${adjustBrightness(theme, -15)}; }
${form.custom_css ? sanitizeCss(form.custom_css) : ''}
</style>
</head>
<body>
<div class="blank-container">
  <div class="blank-card">
${form.header_image_url ? `    <img class="blank-header-img" src="${esc(form.header_image_url)}" alt="">` : ''}
    <h1 class="blank-title">${esc(form.name)}</h1>
${form.description ? `    <p class="blank-desc">${esc(form.description)}</p>` : ''}
    <form id="blankForm" novalidate>
${fields.map((f) => renderField(f)).join('\n')}
${form.captcha_enabled ? renderCaptchaWidget() : ''}
      <button type="submit" class="blank-submit" id="submitBtn">Submit</button>
      <div id="formError" class="blank-error" style="display:none"></div>
    </form>
    <div id="successMsg" style="display:none">
      <div class="blank-success">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--theme)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p id="successText"></p>
      </div>
    </div>
  </div>
</div>
<script>
${clientScript(form)}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  margin: 0; padding: 24px 16px; background: #f3f4f6; color: #111827; line-height: 1.5;
}
.blank-container { max-width: 640px; margin: 0 auto; }
.blank-card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.blank-header-img { width: 100%; max-height: 200px; object-fit: cover; border-radius: 8px; margin-bottom: 20px; }
.blank-title { font-size: 1.5rem; font-weight: 700; margin: 0 0 8px; }
.blank-desc { color: #6b7280; margin: 0 0 24px; }
.blank-field { margin-bottom: 20px; }
.blank-label { display: block; font-weight: 600; font-size: 0.875rem; margin-bottom: 6px; color: #374151; }
.blank-label .req { color: #ef4444; margin-left: 2px; }
.blank-help { font-size: 0.75rem; color: #9ca3af; margin-top: 4px; }
.blank-input, .blank-textarea, .blank-select {
  width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem;
  color: #111827; background: #fff; transition: border-color .15s, box-shadow .15s; outline: none;
}
.blank-input:focus, .blank-textarea:focus, .blank-select:focus {
  border-color: var(--theme); box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme) 20%, transparent);
}
.blank-textarea { min-height: 100px; resize: vertical; }
.blank-radio-group, .blank-checkbox-group { display: flex; flex-direction: column; gap: 8px; }
.blank-radio-item, .blank-checkbox-item { display: flex; align-items: center; gap: 8px; font-size: 0.875rem; cursor: pointer; }
.blank-radio-item input, .blank-checkbox-item input { accent-color: var(--theme); width: 16px; height: 16px; }
.blank-section-header { font-size: 1.125rem; font-weight: 700; margin: 28px 0 8px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #111827; }
.blank-paragraph { color: #6b7280; margin-bottom: 16px; font-size: 0.875rem; }
.blank-page-break { border: none; border-top: 2px dashed #d1d5db; margin: 24px 0; }
.blank-submit {
  display: block; width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 1rem;
  font-weight: 600; color: #fff; background: var(--theme); cursor: pointer; margin-top: 8px;
  transition: background .15s;
}
.blank-submit:hover { background: var(--theme-hover); }
.blank-submit:disabled { opacity: .6; cursor: not-allowed; }
.blank-error { color: #ef4444; font-size: 0.875rem; margin-top: 12px; text-align: center; }
.blank-field-error { color: #ef4444; font-size: 0.75rem; margin-top: 4px; }
.blank-success { text-align: center; padding: 32px 0; }
.blank-success svg { margin-bottom: 16px; }
.blank-success p { font-size: 1.125rem; color: #374151; }
.blank-rating { display: flex; gap: 4px; flex-direction: row-reverse; justify-content: flex-end; }
.blank-rating input { display: none; }
.blank-rating label { font-size: 1.75rem; color: #d1d5db; cursor: pointer; transition: color .1s; }
.blank-rating input:checked ~ label, .blank-rating label:hover, .blank-rating label:hover ~ label { color: #f59e0b; }
.blank-scale-row { display: flex; align-items: center; gap: 12px; }
.blank-scale-label { font-size: 0.75rem; color: #6b7280; min-width: 60px; }
.blank-scale-label.end { text-align: right; }
.blank-scale-row input[type=range] { flex: 1; accent-color: var(--theme); }
.blank-scale-value { min-width: 32px; text-align: center; font-weight: 600; font-size: 0.875rem; color: var(--theme); }
.blank-captcha { margin-bottom: 16px; }
`;

// ---------------------------------------------------------------------------
// Field renderers
// ---------------------------------------------------------------------------

function renderField(f: FormField): string {
  const reqMark = f.required ? '<span class="req">*</span>' : '';
  const helpText = f.description ? `<div class="blank-help">${esc(f.description)}</div>` : '';

  switch (f.field_type) {
    case 'section_header':
      return `    <div class="blank-section-header" data-field-type="section_header">${esc(f.label)}</div>`;

    case 'paragraph':
      return `    <div class="blank-paragraph">${esc(f.label)}</div>`;

    case 'page_break':
      // Layout-only: this single-page renderer flattens pages, so a page
      // break shows as a horizontal divider rather than a stray input.
      return `    <hr class="blank-page-break" data-field-type="page_break">`;

    case 'short_text':
    case 'email':
    case 'phone':
    case 'url':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <input class="blank-input" type="${inputType(f.field_type)}" name="${esc(f.field_key)}"
          placeholder="${esc(f.placeholder ?? '')}"
          ${f.required ? 'required' : ''}
          ${f.min_length ? `minlength="${f.min_length}"` : ''}
          ${f.max_length ? `maxlength="${f.max_length}"` : ''}
          ${f.default_value ? `value="${esc(f.default_value)}"` : ''}
          ${f.regex_pattern ? `pattern="${esc(f.regex_pattern)}"` : ''}>
        ${helpText}`);

    case 'long_text':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <textarea class="blank-textarea" name="${esc(f.field_key)}"
          placeholder="${esc(f.placeholder ?? '')}"
          ${f.required ? 'required' : ''}
          ${f.min_length ? `minlength="${f.min_length}"` : ''}
          ${f.max_length ? `maxlength="${f.max_length}"` : ''}>${esc(f.default_value ?? '')}</textarea>
        ${helpText}`);

    case 'number':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <input class="blank-input" type="number" name="${esc(f.field_key)}"
          placeholder="${esc(f.placeholder ?? '')}"
          ${f.required ? 'required' : ''}
          ${f.min_value !== null ? `min="${esc(f.min_value)}"` : ''}
          ${f.max_value !== null ? `max="${esc(f.max_value)}"` : ''}
          ${f.default_value ? `value="${esc(f.default_value)}"` : ''}>
        ${helpText}`);

    case 'date':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <input class="blank-input" type="date" name="${esc(f.field_key)}"
          ${f.required ? 'required' : ''}
          ${f.default_value ? `value="${esc(f.default_value)}"` : ''}>
        ${helpText}`);

    case 'time':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <input class="blank-input" type="time" name="${esc(f.field_key)}"
          ${f.required ? 'required' : ''}
          ${f.default_value ? `value="${esc(f.default_value)}"` : ''}>
        ${helpText}`);

    case 'datetime':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <input class="blank-input" type="datetime-local" name="${esc(f.field_key)}"
          ${f.required ? 'required' : ''}
          ${f.default_value ? `value="${esc(f.default_value)}"` : ''}>
        ${helpText}`);

    case 'single_select':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <div class="blank-radio-group">
          ${renderOptions(f, 'radio')}
        </div>
        ${helpText}`);

    case 'dropdown':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <select class="blank-select" name="${esc(f.field_key)}" ${f.required ? 'required' : ''}>
          <option value="">${esc(f.placeholder ?? 'Select an option...')}</option>
          ${renderSelectOptions(f)}
        </select>
        ${helpText}`);

    case 'multi_select':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <div class="blank-checkbox-group">
          ${renderOptions(f, 'checkbox')}
        </div>
        ${helpText}`);

    case 'checkbox':
      return fieldWrap(f, `
        <label class="blank-checkbox-item">
          <input type="checkbox" name="${esc(f.field_key)}" ${f.required ? 'required' : ''} ${f.default_value === 'true' ? 'checked' : ''}>
          <span>${esc(f.label)}${reqMark}</span>
        </label>
        ${helpText}`);

    case 'toggle':
      return fieldWrap(f, `
        <label class="blank-checkbox-item">
          <input type="checkbox" name="${esc(f.field_key)}" ${f.default_value === 'true' ? 'checked' : ''}>
          <span>${esc(f.label)}</span>
        </label>
        ${helpText}`);

    case 'rating':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        ${renderRatingStars(f)}
        ${helpText}`);

    case 'scale':
    case 'nps':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        ${renderScale(f)}
        ${helpText}`);

    case 'file_upload':
    case 'image_upload':
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <input class="blank-input" type="file" name="${esc(f.field_key)}"
          ${f.required ? 'required' : ''}
          ${f.allowed_file_types?.length ? `accept="${esc(f.allowed_file_types.join(','))}"` : ''}
          ${f.field_type === 'image_upload' ? 'accept="image/*"' : ''}>
        ${f.max_file_size_mb ? `<div class="blank-help">Max file size: ${f.max_file_size_mb}MB</div>` : ''}
        ${helpText}`);

    case 'hidden':
      return `    <input type="hidden" name="${esc(f.field_key)}" value="${esc(f.default_value ?? '')}">`;

    default:
      return fieldWrap(f, `
        <label class="blank-label">${esc(f.label)}${reqMark}</label>
        <input class="blank-input" type="text" name="${esc(f.field_key)}"
          placeholder="${esc(f.placeholder ?? '')}"
          ${f.required ? 'required' : ''}>
        ${helpText}`);
  }
}

function fieldWrap(f: FormField, inner: string): string {
  return `    <div class="blank-field" data-field-key="${esc(f.field_key)}" data-field-type="${esc(f.field_type)}">${inner}
      <div class="blank-field-error" data-error-for="${esc(f.field_key)}"></div>
    </div>`;
}

function inputType(fieldType: string): string {
  switch (fieldType) {
    case 'email': return 'email';
    case 'phone': return 'tel';
    case 'url': return 'url';
    default: return 'text';
  }
}

function renderOptions(f: FormField, type: 'radio' | 'checkbox'): string {
  const opts = normalizeOptions(f.options);
  const name = esc(f.field_key);
  const itemClass = type === 'radio' ? 'blank-radio-item' : 'blank-checkbox-item';
  return opts
    .map(
      (o) =>
        `<label class="${itemClass}"><input type="${type}" name="${name}" value="${esc(o.value)}"> <span>${esc(o.label)}</span></label>`,
    )
    .join('\n          ');
}

function renderSelectOptions(f: FormField): string {
  const opts = normalizeOptions(f.options);
  return opts
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
    .join('\n          ');
}

function renderRatingStars(f: FormField): string {
  const max = f.scale_max ?? 5;
  const min = f.scale_min ?? 1;
  const name = esc(f.field_key);
  const stars: string[] = [];
  // Render in reverse for CSS adjacent-sibling trick
  for (let i = max; i >= min; i--) {
    stars.push(
      `<input type="radio" name="${name}" id="${name}_${i}" value="${i}"><label for="${name}_${i}" title="${i} star${i !== 1 ? 's' : ''}">&#9733;</label>`,
    );
  }
  return `<div class="blank-rating">${stars.join('')}</div>`;
}

function renderScale(f: FormField): string {
  const min = f.field_type === 'nps' ? 0 : (f.scale_min ?? 1);
  const max = f.field_type === 'nps' ? 10 : (f.scale_max ?? 5);
  const midpoint = Math.round((min + max) / 2);
  const name = esc(f.field_key);
  const minLabel = f.scale_min_label ?? String(min);
  const maxLabel = f.scale_max_label ?? String(max);
  return `<div class="blank-scale-row">
          <span class="blank-scale-label">${esc(minLabel)}</span>
          <input type="range" name="${name}" min="${min}" max="${max}" value="${midpoint}" oninput="document.getElementById('${name}_val').textContent=this.value">
          <span class="blank-scale-value" id="${name}_val">${midpoint}</span>
          <span class="blank-scale-label end">${esc(maxLabel)}</span>
        </div>`;
}

function renderCaptchaWidget(): string {
  const siteKey = process.env.CAPTCHA_SITE_KEY ?? '';
  if (!siteKey) return '<!-- CAPTCHA enabled but no CAPTCHA_SITE_KEY configured -->';
  return `      <div class="blank-captcha">
        <div class="cf-turnstile" data-sitekey="${esc(siteKey)}"></div>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      </div>`;
}

// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------

interface FieldOption {
  value: string;
  label: string;
}

function normalizeOptions(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o: unknown) => {
    if (typeof o === 'string') return { value: o, label: o };
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const value = String(obj.value ?? obj.label ?? '');
      const label = String(obj.label ?? obj.value ?? '');
      return { value, label };
    }
    return { value: String(o), label: String(o) };
  });
}

// ---------------------------------------------------------------------------
// Shuffle support
// ---------------------------------------------------------------------------

function maybeShuffleFields(fields: FormField[], shuffle: boolean): FormField[] {
  if (!shuffle) return fields;

  // Section headers stay in place as anchors; other fields within each
  // section are shuffled independently.
  const result: FormField[] = [];
  let currentSection: FormField[] = [];

  for (const field of fields) {
    if (field.field_type === 'section_header') {
      // Flush the accumulated section with shuffled order
      if (currentSection.length > 0) {
        result.push(...fisherYatesShuffle(currentSection));
        currentSection = [];
      }
      result.push(field);
    } else {
      currentSection.push(field);
    }
  }

  // Flush remaining fields
  if (currentSection.length > 0) {
    result.push(...fisherYatesShuffle(currentSection));
  }

  return result;
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Client-side script
// ---------------------------------------------------------------------------

function clientScript(form: FormData): string {
  // Build a minimal field-definition array for client-side validation
  const fieldDefs = form.fields
    .filter((f) => !['section_header', 'paragraph', 'hidden', 'page_break'].includes(f.field_type))
    .map((f) => ({
      key: f.field_key,
      type: f.field_type,
      required: f.required,
      label: f.label,
      minLength: f.min_length,
      maxLength: f.max_length,
      minValue: f.min_value,
      maxValue: f.max_value,
      pattern: f.regex_pattern,
      scaleMin: f.scale_min,
      scaleMax: f.scale_max,
    }));

  const confirmationType = form.confirmation_type;
  const confirmationMessage = form.confirmation_message ?? 'Thank you for your submission!';
  const confirmationRedirect = form.confirmation_redirect_url ?? '';
  const captchaEnabled = form.captcha_enabled;

  return `
(function() {
  var FIELDS = ${JSON.stringify(fieldDefs)};
  var SLUG = ${JSON.stringify(form.slug)};
  var CONFIRM_TYPE = ${JSON.stringify(confirmationType)};
  var CONFIRM_MSG = ${JSON.stringify(confirmationMessage)};
  var CONFIRM_URL = ${JSON.stringify(confirmationRedirect)};
  var CAPTCHA = ${JSON.stringify(captchaEnabled)};

  var form = document.getElementById('blankForm');
  var submitBtn = document.getElementById('submitBtn');
  var formError = document.getElementById('formError');
  var successDiv = document.getElementById('successMsg');
  var successText = document.getElementById('successText');

  var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  var URL_RE = /^https?:\\/\\/.+/;
  var PHONE_RE = /^[+]?[\\d\\s().-]{7,20}$/;

  function clearErrors() {
    var els = form.querySelectorAll('.blank-field-error');
    for (var i = 0; i < els.length; i++) els[i].textContent = '';
    formError.style.display = 'none';
  }

  function showFieldError(key, msg) {
    var el = form.querySelector('[data-error-for="' + key + '"]');
    if (el) el.textContent = msg;
  }

  function gatherData() {
    var data = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var key = f.key;

      if (f.type === 'checkbox' || f.type === 'toggle') {
        var cb = form.querySelector('input[name="' + key + '"]');
        data[key] = cb ? cb.checked : false;
      } else if (f.type === 'multi_select') {
        var checks = form.querySelectorAll('input[name="' + key + '"]:checked');
        var vals = [];
        for (var j = 0; j < checks.length; j++) vals.push(checks[j].value);
        data[key] = vals;
      } else if (f.type === 'single_select') {
        var radio = form.querySelector('input[name="' + key + '"]:checked');
        data[key] = radio ? radio.value : '';
      } else if (f.type === 'number' || f.type === 'rating' || f.type === 'scale' || f.type === 'nps') {
        var inp = form.querySelector('[name="' + key + '"]');
        if (!inp) continue;
        if (f.type === 'rating') {
          var checked = form.querySelector('input[name="' + key + '"]:checked');
          data[key] = checked ? Number(checked.value) : '';
        } else {
          data[key] = inp.value !== '' ? Number(inp.value) : '';
        }
      } else if (f.type === 'file_upload' || f.type === 'image_upload') {
        // File uploads handled separately; store filename for now
        var fileInp = form.querySelector('input[name="' + key + '"]');
        data[key] = fileInp && fileInp.files.length ? fileInp.files[0].name : '';
      } else {
        var el = form.querySelector('[name="' + key + '"]');
        data[key] = el ? el.value : '';
      }
    }
    return data;
  }

  function validate(data) {
    var errors = [];
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = data[f.key];
      var empty = (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));

      if (f.required && empty) {
        errors.push({ key: f.key, msg: f.label + ' is required' });
        continue;
      }
      if (empty) continue;

      if (f.type === 'email' && !EMAIL_RE.test(v)) {
        errors.push({ key: f.key, msg: f.label + ' must be a valid email' });
      }
      if (f.type === 'url' && !URL_RE.test(v)) {
        errors.push({ key: f.key, msg: f.label + ' must be a valid URL' });
      }
      if (f.type === 'phone' && !PHONE_RE.test(v)) {
        errors.push({ key: f.key, msg: f.label + ' must be a valid phone number' });
      }
      if ((f.type === 'number' || f.type === 'rating' || f.type === 'scale' || f.type === 'nps') && typeof v === 'number') {
        if (f.minValue !== null && v < Number(f.minValue)) errors.push({ key: f.key, msg: f.label + ' must be at least ' + f.minValue });
        if (f.maxValue !== null && v > Number(f.maxValue)) errors.push({ key: f.key, msg: f.label + ' must be at most ' + f.maxValue });
      }
      if (typeof v === 'string' && f.minLength && v.length < f.minLength) {
        errors.push({ key: f.key, msg: f.label + ' must be at least ' + f.minLength + ' characters' });
      }
      if (typeof v === 'string' && f.maxLength && v.length > f.maxLength) {
        errors.push({ key: f.key, msg: f.label + ' must be at most ' + f.maxLength + ' characters' });
      }
      if (f.pattern && typeof v === 'string') {
        try { if (!new RegExp(f.pattern).test(v)) errors.push({ key: f.key, msg: f.label + ' does not match the required format' }); } catch(e) {}
      }
    }
    return errors;
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    clearErrors();

    var data = gatherData();
    var errors = validate(data);
    if (errors.length > 0) {
      for (var i = 0; i < errors.length; i++) showFieldError(errors[i].key, errors[i].msg);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    var payload = { response_data: data };

    // Extract email for one_per_email enforcement
    var emailField = data.email || null;
    if (emailField) payload.email = emailField;

    // CAPTCHA token
    if (CAPTCHA && typeof turnstile !== 'undefined') {
      var token = turnstile.getResponse();
      if (token) payload.captcha_token = token;
    }

    fetch('/forms/' + encodeURIComponent(SLUG) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(res) {
      if (!res.ok) return res.json().then(function(body) { throw body; });
      return res.json();
    })
    .then(function(result) {
      var ct = (result.data && result.data.confirmation_type) || CONFIRM_TYPE;
      if (ct === 'redirect') {
        var url = (result.data && result.data.confirmation_redirect_url) || CONFIRM_URL;
        if (url) { window.location.href = url; return; }
      }
      var msg = (result.data && result.data.confirmation_message) || CONFIRM_MSG;
      form.style.display = 'none';
      successText.textContent = msg;
      successDiv.style.display = 'block';
    })
    .catch(function(err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
      var msg = 'Something went wrong. Please try again.';
      if (err && err.error && err.error.message) msg = err.error.message;
      formError.textContent = msg;
      formError.style.display = 'block';
    });
  });
})();
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Basic CSS sanitization: strip anything that looks like a JS expression,
 * import, or url() with non-http schemes. The form's custom_css is already
 * stored sanitized, but we add a defense-in-depth layer here.
 */
function sanitizeCss(css: string): string {
  return css
    .replace(/@import\b/gi, '/* blocked-import */')
    .replace(/expression\s*\(/gi, '/* blocked-expression */(')
    .replace(/javascript\s*:/gi, '/* blocked-js */')
    .replace(/url\s*\(\s*(?!['"]?https?:)/gi, 'url(about:blank');
}

/**
 * Adjust a hex colour brightness by a percentage (-100 to 100).
 */
function adjustBrightness(hex: string, percent: number): string {
  const h = hex.replace('#', '');
  const r = Math.max(0, Math.min(255, parseInt(h.substring(0, 2), 16) + Math.round(2.55 * percent)));
  const g = Math.max(0, Math.min(255, parseInt(h.substring(2, 4), 16) + Math.round(2.55 * percent)));
  const b = Math.max(0, Math.min(255, parseInt(h.substring(4, 6), 16) + Math.round(2.55 * percent)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
