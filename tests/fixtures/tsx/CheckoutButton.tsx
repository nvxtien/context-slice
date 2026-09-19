import { useEffect, useState } from "react";
import { OrderSummary } from "./OrderSummary";
import { checkout } from "./checkout";

export function CheckoutButton({ cartId }: { cartId: string }) {
  const [done, setDone] = useState(false);

  const handleClick = async () => {
    const ok = await checkout(cartId);
    setDone(ok);
  };

  useEffect(() => {
    handleClick();
  }, [cartId]);

  return (
    <div>
      <OrderSummary total={42} />
      <button onClick={handleClick}>Buy</button>
    </div>
  );
}

export class LegacyCheckout extends CheckoutBase {
  render() {
    return <CheckoutButton cartId="legacy" />;
  }
}

declare class CheckoutBase {}
