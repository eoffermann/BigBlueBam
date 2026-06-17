-- 0196_blank_field_type_page_break.sql
-- Why: the Blank form builder ships a "Page Break" palette item that posts
--      field_type='page_break', but migration 0037 created blank_form_fields
--      with a CHECK constraint that omits it, so adding a page break failed
--      with a check-constraint violation (HTTP 500). page_break is a real,
--      layout-only field type (it splits the form into pages); the route Zod
--      enum, the submission validator, and the renderer all now accept it.
-- Client impact: additive only. Widens the allowed field_type set by one
--      value; no existing rows change.

DO $$
BEGIN
  ALTER TABLE blank_form_fields
    DROP CONSTRAINT IF EXISTS blank_form_fields_field_type_check;

  ALTER TABLE blank_form_fields
    ADD CONSTRAINT blank_form_fields_field_type_check
    CHECK (field_type IN (
      'short_text', 'long_text', 'email', 'phone', 'url', 'number',
      'single_select', 'multi_select', 'dropdown',
      'date', 'time', 'datetime',
      'file_upload', 'image_upload',
      'rating', 'scale', 'nps',
      'checkbox', 'toggle',
      'section_header', 'paragraph',
      'hidden', 'page_break'
    ));
EXCEPTION
  WHEN undefined_table THEN NULL;
END $$;
