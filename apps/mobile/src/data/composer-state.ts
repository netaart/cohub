export type ComposerActionStateInput = {
  text: string;
  hasAttachment: boolean;
  disabled: boolean;
  sending: boolean;
  running: boolean;
  hasStopHandler: boolean;
};

export type ComposerActionState = {
  blocked: boolean;
  hasDraft: boolean;
  canSend: boolean;
  canStop: boolean;
};

export function getComposerActionState(input: ComposerActionStateInput): ComposerActionState {
  const blocked = input.disabled || input.sending;
  const hasDraft = input.text.trim().length > 0 || input.hasAttachment;
  return {
    blocked,
    hasDraft,
    canSend: hasDraft && !blocked,
    canStop: input.running && !blocked && !hasDraft && input.hasStopHandler,
  };
}
