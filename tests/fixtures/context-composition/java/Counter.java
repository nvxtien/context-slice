package demo;

public class Counter {
  private int count;
  private String label;

  public void increment() {
    count++;
  }

  public int current() {
    return count;
  }

  public String describe() {
    return label;
  }
}
