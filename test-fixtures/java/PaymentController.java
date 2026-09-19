package demo;
import org.springframework.web.bind.annotation.PostMapping;
public class PaymentController {
  private final PaymentService service;
  @PostMapping("/retry")
  public RetryResult retry(String id) { return service.retryPayment(id); }
}
