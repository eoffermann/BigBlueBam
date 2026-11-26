// Injection pre-scan for cited labels (spec 2.4): the categories of
// apps/bursar-api/src/lib/injection-prescan.ts, minus Bursar's RFQ blanket-claim lexicon (a
// control label is never a coverage claim). Pure and deterministic.
//
// Every label a fix draft cites (a PR title, a repository name, a key label, a person's display
// name) passes through here before it reaches a draft. A suspect label is never quoted: the
// draft cites the entity by kind only and records the signal, so text written by whoever named a
// PR cannot steer what Bastion drafts. Labels that pass are still delimited as data
// (`delimitAsData`) wherever they enter a prompt (M7) or a drafted body.

export type InjectionCategory = 'imperative_directive' | 'instruction_override' | 'role_token' | 'control_run';

export interface InjectionScanResult {
  suspected: boolean;
  categories: InjectionCategory[];
}

const IMPERATIVE_PATTERNS: RegExp[] = [
  /\b(?:you|your)\b[^.\n]{0,40}\b(?:must|should|shall|are to|need to|are required to|have to|will)\b/gi,
  /\b(?:please|kindly)\b[^.\n]{0,30}\b(?:mark|treat|consider|rate|score|classify|assume|ignore|approve|confirm)\b/gi,
  /\b(?:mark|treat|consider|classify|score|rate)\b[^.\n]{0,30}\b(?:as (?:fully )?(?:covered|complete|compliant|included|passing)|covered|compliant)\b/gi,
];

const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,30}\b(?:above|previous|prior|earlier|preceding|instruction|instructions|rules?|prompt|context)\b/gi,
  /\bnew\s+(?:instruction|instructions|rules?|directive|directives|prompt)\b/gi,
  /\b(?:system|developer)\s+(?:prompt|message|instruction)\b/gi,
  /\bdo\s+not\s+(?:flag|report|mark|note|list|surface|exclude)\b/gi,
];

const ROLE_PATTERNS: RegExp[] = [
  /\bas\s+an?\s+(?:ai|assistant|language\s+model|llm)\b/gi,
  /\byou\s+are\s+(?:an?\s+)?(?:ai|assistant|chatgpt|claude|gpt|language\s+model|llm|reviewer|evaluator|auditor)\b/gi,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/gi,
  /^\s*(?:system|assistant|user)\s*:/gim,
  /#{2,}\s*(?:instruction|system|prompt)/gi,
];

// Two or more zero-width or bidirectional control characters in a row.
const CONTROL_RUN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]{2,}/;

function hits(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

export function scanLabel(text: string): InjectionScanResult {
  const categories: InjectionCategory[] = [];
  if (text) {
    if (hits(text, IMPERATIVE_PATTERNS)) categories.push('imperative_directive');
    if (hits(text, OVERRIDE_PATTERNS)) categories.push('instruction_override');
    if (hits(text, ROLE_PATTERNS)) categories.push('role_token');
    if (CONTROL_RUN.test(text)) categories.push('control_run');
  }
  return { suspected: categories.length > 0, categories };
}

/** Wrap a label as inert data: one line, bounded, inside a delimiter it cannot close. */
export function delimitAsData(label: string, max = 200): string {
  const flat = label.replace(/[\r\n\t]+/g, ' ').replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '').trim();
  const bounded = flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
  return `«${bounded.replace(/[«»]/g, '')}»`;
}
