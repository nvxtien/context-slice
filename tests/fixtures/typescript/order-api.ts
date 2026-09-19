import * as math from "./utils/math";
import express from "express";
import { OrderService } from "./order-service";
import type { CreateOrderInput } from "./types";

export async function createOrder(input: CreateOrderInput): Promise<string> {
  const service: OrderService = new OrderService();
  const total = math.calculateTotal(input.items);
  const app = express();
  app.listen(3000);
  return service.create(input);
}

export default createOrder;
