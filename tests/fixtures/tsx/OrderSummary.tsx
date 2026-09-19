import { formatPrice } from "./checkout";

export interface OrderSummaryProps {
  total: number;
}

export const OrderSummary = ({ total }: OrderSummaryProps) => (
  <section className="summary">{formatPrice(total)}</section>
);
