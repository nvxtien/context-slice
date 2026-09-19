package demo;
public class PaymentServiceTest {
  public void retriesFailedPayment() { new PaymentService(null, null).retryPayment("p-1"); }
}
