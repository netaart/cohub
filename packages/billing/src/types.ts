export type BillingClientConfig = {
  baseUrl: string;
  businessKey: string;
  adminApiKey: string;
};

export type BillingRuntimeConfig = {
  talesofaiBillingBaseUrl?: string;
  talesofaiBillingBusinessKey?: string;
  talesofaiBillingSpaceWalletBusinessKey?: string;
  talesofaiBillingAdminApiKey?: string;
  talesofaiBillingWebhookSecret?: string;
};
