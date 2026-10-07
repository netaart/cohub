/** OTEL_SERVICE_NAME names the deployment when one image backs several. */
export const serviceNameFromEnv = (fallback: string) => process.env.OTEL_SERVICE_NAME?.trim() || fallback;
