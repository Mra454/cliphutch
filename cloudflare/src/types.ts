export type Env = {
  DB: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  MAX_DEVICES_PER_LICENSE: string;
  COMPUTEDKIT_MAX_DEVICES_PER_LICENSE?: string;
  COMPUTEDKIT_STRIPE_PRICE_ID?: string;
  COMPUTEDKIT_SUCCESS_URL?: string;
  COMPUTEDKIT_CANCEL_URL?: string;
};

export type LicenseRow = {
  key: string;
  email: string;
  stripe_session_id: string;
  payment_intent_id: string | null;
  product: "cliphutch" | "computedkit";
  status: "active" | "refunded" | "revoked";
  created_at: number;
  refunded_at: number | null;
};

export type ActivationRow = {
  license_key: string;
  installation_id: string;
  activated_at: number;
  last_seen_at: number;
};
