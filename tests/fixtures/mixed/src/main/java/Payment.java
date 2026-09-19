package demo;

public class Payment {
  public void retryPayment(String id) {
    audit(id);
  }

  private void audit(String id) {}
}
