package com.example.user;
public class UserService {
  public UserService() {}
  public UserService(String name) {}
  public void save(User user) {}
  public void save(java.util.List<User> users) {}
  public void save(User... users) {}
  static class Inner { public void run() {} }
  record Event(String id) { public String value() { return id; } }
  enum Status { NEW, DONE; public String label() { return name(); } }
  public <T> T convert(Object value, Class<T> type) { return type.cast(value); }
}
class User {}
