import type { AttributeValue } from "@opentelemetry/api";

type AuthTraceSpan = {
  setAttribute(name: string, value: AttributeValue): unknown;
};

export type AuthPrincipalType =
  | "anonymous"
  | "user"
  | "execution"
  | "preview_session"
  | "app_session";

export type AuthTraceOutcome = "anonymous" | "authenticated" | "rejected";

export function recordAuthTrace(
  span: AuthTraceSpan | undefined,
  attributes: {
    credentialPresent: boolean;
    principalType: AuthPrincipalType;
    outcome: AuthTraceOutcome;
    failureCategory?: "invalid_user_token" | "ended_app_session";
  },
) {
  if (!span) return;
  span.setAttribute("cohub.auth.credential_present", attributes.credentialPresent);
  span.setAttribute("cohub.auth.principal_type", attributes.principalType);
  span.setAttribute("cohub.auth.outcome", attributes.outcome);
  if (attributes.failureCategory) {
    span.setAttribute("cohub.auth.failure_category", attributes.failureCategory);
  }
}
