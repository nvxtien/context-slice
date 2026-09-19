interface PaymentRepository { void save(Payment payment); }
class JpaPaymentRepository implements PaymentRepository { public void save(Payment payment) {} }
class PaymentService { private PaymentRepository repository; void persist(Payment payment) { repository.save(payment); } }
class Payment {}
