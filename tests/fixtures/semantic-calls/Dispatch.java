package semantic;

interface Repository { void save(Item item); }
class JpaRepository implements Repository { public void save(Item item) {} }
class Parent { void inherited() {} }
class Service extends Parent {
  private Repository repository;
  void run(Item item) {
    local();
    repository.save(item);
    inherited();
    new Item();
  }
  void local() {}
  void overloaded(String value) {}
  void overloaded(Long value) {}
}
class Item { Item() {} }
