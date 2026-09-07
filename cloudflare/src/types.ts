export type LicenseRow = {
  key: string;
  email: string;
  stripe_session_id: string;
  payment_intent_id: string | null;
  product: "cliphutch" | "computedkit";
  status: "active" | "refunded" | "revoked";
  created_at: number;
  refunded_at: number | null;
  refunded_event_id: string | null;
  refund_amount: number | null;
  refund_amount_refunded: number | null;
  email_sent_at: number | null;
  email_delivery_key: string | null;
  email_delivery_claimed_at: number | null;
};

export type ActivationRow = {
  license_key: string;
  installation_id: string;
  activated_at: number;
  last_seen_at: number;
  created_event_id: string | null;
};
