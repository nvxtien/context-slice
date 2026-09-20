import type { Cart } from "./cart";

export interface Repo {
  save(cart: Cart): string;
}

export interface Bus {
  publish(event: string): void;
}

export class OrderService {
  constructor(
    private readonly repo: Repo,
    private readonly events: Bus,
  ) {}

  create(cart: Cart): string {
    return this.repo.save(cart);
  }

  announce(): void {
    this.events.publish("created");
  }
}
