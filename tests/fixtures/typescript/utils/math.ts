import type { OrderItem } from "../types";

export const calculateTotal = (items: OrderItem[]): number =>
  items.reduce((total, item) => total + item.price * item.quantity, 0);

export const applyDiscount = function (total: number, percent: number): number {
  return total - total * percent;
};

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function outer(total: number): number {
  const inner = () => roundCents(total);
  return inner();
}
