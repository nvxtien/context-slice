package semantic;
import java.util.Objects;
class StaticAndChain {
  void run(String value) {
    Objects.requireNonNull(value);
    value.trim().toString();
    value.trim();
  }
}
