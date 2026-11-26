import type { BastionTemplateKey } from '@bigbluebam/shared';

/** One framework requirement and the internal controls that satisfy it (spec 2.1). */
export interface TemplateRequirement {
  /** The public reference code (for example `CC6.1` or `A.5.17`). Stable; never reworded. */
  ref_code: string;
  /** Our own short plain title. */
  title: string;
  /** Our own plain-language summary; never the official AICPA or ISO text. */
  plain_summary: string;
  /** controls.ts keys. Two requirements naming the same key share one control. */
  control_keys: string[];
}

export interface FrameworkTemplate {
  template_key: BastionTemplateKey;
  /** Bumped when the requirement list or crosswalk changes; stored on the adopted framework. */
  template_version: string;
  name: string;
  /** ISO frameworks get a Statement of Applicability and the completeness gate (spec 2.1). */
  is_iso: boolean;
  description: string;
  requirements: TemplateRequirement[];
}
