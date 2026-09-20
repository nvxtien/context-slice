interface Item {
  sku: string;
  price: number;
}

export class Cart {
  private total = 0;
  private auditLog: string[] = [];

  add(item: Item): void {
    this.total += item.price;
  }

  getTotal(): number {
    return this.total;
  }

  unrelated(sku: string): string {
    this.auditLog.push(sku);
    return sku.toUpperCase();
  }
}
