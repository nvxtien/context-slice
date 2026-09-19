package demo;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PaymentService {
  private final PaymentRepository repository;
  private final PaymentEventPublisher publisher;

  @Transactional
  public RetryResult retryPayment(String id) {
    Payment payment = repository.find(id);
    if (payment.status() != Status.FAILED) return RetryResult.ignored();
    repository.save(payment.retry());
    publisher.publish(payment.event());
    audit(id);
    return RetryResult.accepted();
  }

  private void audit(String id) { System.out.println(id); }
  public void retryPayment(String id, boolean force) { retryPayment(id); }
}
