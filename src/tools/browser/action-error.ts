/** Model-correctable browser mistakes. Only these fixed codes cross the worker/HTTP boundaries, never free text. */
export const ACTION_ERRORS = {
  stale_reference: 'Reference is stale or invalid; call browser_snapshot for the current revision and refs.',
  link_changed: 'The link changed, is not a link, or requires approval; take a new snapshot and use a current link ref.',
  use_follow_or_form: 'Use browser_follow for links or browser_form_prepare for submit buttons; browser_interact only clicks plain buttons, checkboxes and radios.',
  dedicated_operation: 'Credentials, files and multi-select fields are not supported by browser_interact.',
  unavailable_control: 'The control is hidden, disabled or gone; take a new snapshot.',
  invalid_value: 'The field rejected that value.',
  document_changed: 'The page changed during the action; take a new snapshot.',
  select_submit: 'Select a current submit button ref from the latest snapshot.',
  form_unsupported: 'The form cannot be prepared: it has file/password fields, an unsupported encoding or field, a non-HTTPS action or is too large.',
  request_expired: 'The pending request changed or expired; take a new snapshot.',
} as const;
export type ActionCode = keyof typeof ACTION_ERRORS;
export const isActionCode = (value: unknown): value is ActionCode => typeof value === 'string' && Object.hasOwn(ACTION_ERRORS, value);
export class BrowserActionError extends Error {
  constructor(readonly code: ActionCode) { super(ACTION_ERRORS[code]); }
}
