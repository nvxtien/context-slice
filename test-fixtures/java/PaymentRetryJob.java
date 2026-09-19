package demo;
public class PaymentRetryJob {
  private final PaymentService service;
  public void execute(String id) { service.retryPayment(id); }
}
