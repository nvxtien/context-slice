import { SqlOrderRepository } from "./repository";
import { validateOrder } from "./validation";
import { calculateTotal } from "./utils/math";
import type { CreateOrderInput, OrderId } from "./types";

export class OrderService {
  private readonly repository: SqlOrderRepository;

  constructor() {
    this.repository = new SqlOrderRepository("orders");
  }

  async create(input: CreateOrderInput): Promise<OrderId> {
    this.assertValid(input);
    const total = calculateTotal(input.items);
    return this.repository.save(input);
  }

  assertValid(input: CreateOrderInput): void {
    if (!validateOrder(input)) {
      throw new Error("invalid order");
    }
  }
}
