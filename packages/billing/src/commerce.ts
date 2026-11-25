export type FeatureBenefitConfig = {
  metadata: Record<string, string | number | boolean>;
};

export type CreditsBenefitConfig = {
  token_type: string;
  amount: number;
  priority?: number;
  scope: "global" | "business";
  grant_kind: "plan_period" | "purchased" | "manual" | "promo";
  grant_period?: "month" | "day";
  expires_in_days?: number;
};

export type PurchasedCreditsBenefitConfig = CreditsBenefitConfig & {
  grant_kind: "purchased";
};

type BenefitBase = {
  id: string;
  business_id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  config_version?: string;
  created_at?: string;
  updated_at?: string;
};

export type FeatureBenefit = BenefitBase & { type: "feature"; config: FeatureBenefitConfig };

export type CreditsBenefit = BenefitBase & { type: "credits"; config: CreditsBenefitConfig };

export type Benefit = FeatureBenefit | CreditsBenefit;

export type Product = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  billing_type?: string;
  billing_period?: string | null;
  billing_interval_count?: number | null;
  currency?: string;
  amount?: number;
  meta?: Record<string, unknown> | null;
};

export type ProductBenefit = {
  id: string | null;
  product_key?: string;
  benefit_key: string;
  created_at?: string | null;
  [key: string]: unknown;
};

export type CommerceOrder = {
  id: string;
  status: string;
  product_key_snapshot: string;
  product_name_snapshot: string;
  amount_snapshot: number;
  paid_amount_snapshot: number;
  refunded_amount: number;
  currency_snapshot: string;
  created_at: string;
  paid_at: string | null;
  external_user_id?: string | null;
  external_user_id_snapshot?: string | null;
};

export type CommerceCheckout = {
  provider_key?: string | null;
  checkout_url?: string | null;
  checkout_usable?: boolean;
  status?: string | null;
  message?: string | null;
};

export type CommercePage<T> = { items: T[]; pagination: { has_more: boolean } };

type PageInput = { business_key: string; page: number; limit: number; include_count?: false };
type ProductRef = { business_key: string; product_key: string };
type BenefitRef = { business_key: string; benefit_key: string };
type ProductStatus = "draft" | "active" | "archived";
type ProductVisibility = "public" | "private";
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type OrderStatus =
  | "pending_checkout"
  | "pending_payment"
  | "paid"
  | "refunded"
  | "checkout_canceled"
  | "payment_canceled"
  | "checkout_expired"
  | "payment_conflicted";
type OrderSortField = "created_at" | "updated_at" | "paid_at" | "amount_snapshot" | "paid_amount_snapshot" | "status";
type OrderSorting = OrderSortField | `${OrderSortField}:asc` | `${OrderSortField}:desc` | `-${OrderSortField}`;

type BenefitCreateInput = {
  business_key: string;
  key: string;
  name: string;
  description?: string;
  status: "active";
} & (
  | { type: "feature"; config: FeatureBenefitConfig }
  | { type: "credits"; config: PurchasedCreditsBenefitConfig }
);

// Inputs must stay within what the SDK accepts: provider.ts assigns the real SDK to this type.
export interface CommerceSdk {
  admin: {
    businesses: {
      create(input: { key: string; name: string; status: "active" }): Promise<unknown>;
    };
    products: {
      list(input: PageInput): Promise<CommercePage<Product>>;
      get(input: ProductRef): Promise<Product>;
      create(input: {
        business_key: string;
        key: string;
        name: string;
        description?: string;
        status: Exclude<ProductStatus, "archived">;
        visibility: ProductVisibility;
        amount: number;
        currency: "USD";
        billing_type: "one_time";
        billing_period: "one_time";
        billing_interval_count: 1;
        meta?: Record<string, unknown>;
      }): Promise<Product>;
      update(input: {
        product_key: string;
        patch: {
          business_key: string;
          name?: string;
          description?: string | null;
          status?: ProductStatus;
          visibility?: ProductVisibility;
          meta?: Record<string, unknown>;
        };
      }): Promise<Product>;
      bindBenefit(input: ProductRef & { benefit_key: string }): Promise<{
        id: string;
        product_key: string;
        benefit_key: string;
        created_at: string;
      }>;
      unbindBenefit(input: ProductRef & { benefit_key: string }): Promise<unknown>;
      listBenefits(input: ProductRef): Promise<Array<{ benefit_key: string }>>;
      listProductsByBenefit(input: BenefitRef): Promise<Array<{ product: Pick<Product, "meta"> }>>;
      http: {
        request(input: {
          method: HttpMethod;
          path: string;
          pathParams?: Record<string, string>;
          query?: Record<string, string>;
        }): Promise<unknown>;
      };
    };
    benefits: {
      list(input: PageInput): Promise<CommercePage<Benefit>>;
      get(input: BenefitRef): Promise<Benefit>;
      create(input: BenefitCreateInput): Promise<Benefit>;
      update(input: {
        benefit_key: string;
        patch: {
          business_key: string;
          name?: string;
          description?: string | null;
          status?: "active" | "archived";
          config?: FeatureBenefitConfig;
        };
      }): Promise<Benefit>;
    };
    orders: {
      list(input: PageInput & { status?: OrderStatus; sorting?: OrderSorting }): Promise<CommercePage<CommerceOrder>>;
      get(input: { business_key: string; order_id: string }): Promise<CommerceOrder>;
      create(
        input: {
          business_key: string;
          external_user_id: string;
          product_key: string;
          billing_reason: "purchase";
          success_redirect_url: string;
          failed_redirect_url: string;
          cancel_redirect_url: string;
          meta?: Record<string, unknown>;
        },
        options?: { idempotencyKey?: string },
      ): Promise<{
        order: Pick<CommerceOrder, "id" | "product_key_snapshot">;
        checkout?: CommerceCheckout | null;
      }>;
    };
  };
}
