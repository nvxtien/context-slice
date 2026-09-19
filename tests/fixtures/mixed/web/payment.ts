export function retryPayment(id: string): void {
  audit(id);
}

function audit(id: string): void {
  console.log(id);
}
