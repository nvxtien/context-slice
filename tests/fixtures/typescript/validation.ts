import type { CreateOrderInput } from "./types";

export function parse(value: string): number;
export function parse(value: number): number;
export function parse(value: string | number): number {
  return Number(value);
}

export function validateOrder(input: CreateOrderInput): boolean {
  return input.items.length > 0 && parse(input.items.length) > 0;
}
