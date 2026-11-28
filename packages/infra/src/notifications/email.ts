import { createTransport } from "nodemailer";
import { createLogger } from "../logging/index.js";

const REQUEST_TIMEOUT_MS = 15_000;

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
};

export type EmailTransport = {
  readonly provider: "resend" | "smtp" | "log";
  send(message: EmailMessage): Promise<void>;
};

export class PermanentEmailError extends Error {
  constructor(message: string, readonly recipient: boolean) {
    super(message);
  }
}

export function createEmailTransport(input: { url?: string | null; from?: string | null; serviceName: string }): EmailTransport | null {
  const url = input.url?.trim();
  const from = input.from?.trim();
  if (!url) return null;
  if (!from) throw new Error("EMAIL_FROM is required when EMAIL_URL is set");
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();

  if (scheme === "resend") {
    const apiKey = decodeURIComponent(url.slice("resend://".length));
    if (!apiKey) throw new Error("EMAIL_URL resend:// needs an API key");
    return {
      provider: "resend",
      async send(message) {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
          },
          body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text, headers: message.headers }),
        });
        if (response.ok) return;
        const detail = await response.text().catch(() => "");
        const error = `Resend rejected the email (${response.status}): ${detail.slice(0, 300)}`;
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new PermanentEmailError(error, response.status === 422 && /\bto\b/i.test(detail));
        throw new Error(error);
      },
    };
  }

  if (scheme === "smtp" || scheme === "smtps") {
    const transporter = createTransport({ url, connectionTimeout: REQUEST_TIMEOUT_MS, greetingTimeout: REQUEST_TIMEOUT_MS, socketTimeout: REQUEST_TIMEOUT_MS });
    return {
      provider: "smtp",
      async send(message) {
        try {
          await transporter.sendMail({ from, to: message.to, subject: message.subject, html: message.html, text: message.text, headers: message.headers });
        } catch (error) {
          const code = (error as { responseCode?: number }).responseCode;
          const message = error instanceof Error ? error.message : String(error);
          if (code && code >= 500) throw new PermanentEmailError(message, (code === 550 || code === 553) && !/relay/i.test(message));
          throw error;
        }
      },
    };
  }

  if (scheme === "log") {
    const logger = createLogger({ serviceName: input.serviceName });
    return {
      provider: "log",
      async send(message) {
        logger.info("[Email] log transport", { to: message.to, subject: message.subject, text: message.text });
      },
    };
  }

  throw new Error(`Unsupported EMAIL_URL scheme: ${scheme}`);
}
