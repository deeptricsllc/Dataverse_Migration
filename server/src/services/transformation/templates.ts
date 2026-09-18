import type { TransformationTemplateDto } from '../../../../shared/domain';

/**
 * Reusable pipelines for the cleanups every legacy migration needs. A template is applied by
 * copying its rules onto a field mapping, so a later edit to the mapping is independent of the
 * template — nothing is linked, which keeps a run's snapshot meaningful.
 */
export const BUILT_IN_TEMPLATES: TransformationTemplateDto[] = [
  {
    id: 'trim-text',
    name: 'Trim text',
    description: 'Removes leading and trailing whitespace.',
    rules: [{ kind: 'TRIM' }],
    builtIn: true,
  },
  {
    id: 'normalize-email',
    name: 'Normalize email',
    description: 'Trims, lowercases, and turns an empty string into null.',
    rules: [{ kind: 'TRIM' }, { kind: 'LOWERCASE' }, { kind: 'EMPTY_TO_NULL' }],
    builtIn: true,
  },
  {
    id: 'empty-to-null',
    name: 'Empty string to null',
    description: 'A blank legacy string becomes a real null in the target.',
    rules: [{ kind: 'EMPTY_TO_NULL' }],
    builtIn: true,
  },
  {
    id: 'legacy-yes-no',
    name: 'Legacy Y/N to yes-no',
    description: 'Y/N, YES/NO, 1/0 and TRUE/FALSE become a boolean. Nothing else is assumed.',
    rules: [
      { kind: 'TRIM' },
      {
        kind: 'TO_BOOLEAN',
        map: [
          { from: 'Y', to: true },
          { from: 'YES', to: true },
          { from: '1', to: true },
          { from: 'TRUE', to: true },
          { from: 'N', to: false },
          { from: 'NO', to: false },
          { from: '0', to: false },
          { from: 'FALSE', to: false },
        ],
      },
    ],
    builtIn: true,
  },
  {
    id: 'legacy-active-inactive',
    name: 'Legacy ACTIVE/INACTIVE to yes-no',
    description:
      'ACTIVE and INACTIVE become true and false. Deliberately separate from Y/N: "ACTIVE" does not mean true everywhere.',
    rules: [
      { kind: 'TRIM' },
      { kind: 'UPPERCASE' },
      {
        kind: 'TO_BOOLEAN',
        map: [
          { from: 'ACTIVE', to: true },
          { from: 'A', to: true },
          { from: 'INACTIVE', to: false },
          { from: 'I', to: false },
        ],
      },
    ],
    builtIn: true,
  },
  {
    id: 'clean-phone',
    name: 'Clean phone number',
    description: 'Trims and removes the punctuation legacy systems store around phone numbers.',
    rules: [
      { kind: 'TRIM' },
      { kind: 'REPLACE', find: '(', replaceWith: '' },
      { kind: 'REPLACE', find: ')', replaceWith: '' },
      { kind: 'REPLACE', find: '-', replaceWith: '' },
      { kind: 'REPLACE', find: '.', replaceWith: '' },
      { kind: 'EMPTY_TO_NULL' },
    ],
    builtIn: true,
  },
];
