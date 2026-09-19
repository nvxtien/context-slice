import { createOrder, makeOrder, calculateTotal } from "./index";
import handler from "./order-api";
import { SqlOrderRepository } from "./repository";
import { validateOrder as checkOrder } from "./validation";
import type { CreateOrderInput } from "./types";

export async function placeOrder(input: CreateOrderInput): Promise<string> {
  const repository = new SqlOrderRepository("orders");
  const total = calculateTotal(input.items);
  checkOrder(input);
  await makeOrder(input);
  const id = await createOrder(input);
  await repository.save(input);
  return handler(input);
}

export function unknownReceiver(factory: { build(): { run(): void } }): void {
  const made = factory.build();
  made.run();
  made?.run?.();
}
