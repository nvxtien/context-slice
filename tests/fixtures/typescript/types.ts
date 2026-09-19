export interface CreateOrderInput {
  customerId: string;
  items: OrderItem[];
}

export interface OrderItem {
  sku: string;
  price: number;
  quantity: number;
}

export type OrderId = string;

export enum OrderStatus {
  Draft = "draft",
  Placed = "placed",
}
