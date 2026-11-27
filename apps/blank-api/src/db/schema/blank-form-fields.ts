import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  boolean,
  integer,
  numeric,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { blankForms } from './blank-forms.js';

export const blankFormFields = pgTable(
  'blank_form_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    form_id: uuid('form_id')
      .notNull()
      .references(() => blankForms.id, { onDelete: 'cascade' }),
    field_key: varchar('field_key', { length: 60 }).notNull(),
    label: varchar('label', { length: 500 }).notNull(),
    description: text('description'),
    placeholder: varchar('placeholder', { length: 255 }),
    field_type: varchar('field_type', { length: 30 }).notNull(),
    required: boolean('required').notNull().default(false),
    min_length: integer('min_length'),
    max_length: integer('max_length'),
    min_value: numeric('min_value'),
    max_value: numeric('max_value'),
    regex_pattern: varchar('regex_pattern', { length: 255 }),
    options: jsonb('options'),
    scale_min: integer('scale_min').default(1),
    scale_max: integer('scale_max').default(5),
    scale_min_label: varchar('scale_min_label', { length: 100 }),
    scale_max_label: varchar('scale_max_label', { length: 100 }),
    allowed_file_types: text('allowed_file_types').array(),
    max_file_size_mb: integer('max_file_size_mb').default(10),
    conditional_on_field_id: uuid('conditional_on_field_id').references((): AnyPgColumn => blankFormFields.id, { onDelete: 'no action' }),
    conditional_operator: varchar('conditional_operator', { length: 20 }),
    conditional_value: text('conditional_value'),
    sort_order: integer('sort_order').notNull().default(0),
    page_number: integer('page_number').notNull().default(1),
    column_span: integer('column_span').notNull().default(1),
    default_value: text('default_value'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_blank_fields_form').on(table.form_id, table.sort_order),
  ],
);
