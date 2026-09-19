export async function checkout(cartId: string): Promise<boolean> {
  return cartId.length > 0;
}

export function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}
