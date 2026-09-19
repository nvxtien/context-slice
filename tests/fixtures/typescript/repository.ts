import type { CreateOrderInput, OrderId } from "./types";

export interface OrderRepository {
  save(input: CreateOrderInput): Promise<OrderId>;
}

export class SqlOrderRepository implements OrderRepository {
  constructor(private readonly table: string) {}

  async save(input: CreateOrderInput): Promise<OrderId> {
    return this.nextId(input.customerId);
  }

  private nextId(customerId: string): OrderId {
    return `${this.table}-${customerId}`;
  }
}
