package com.example.admin;
public class UserService {
  public void save(String user) {}
}
interface AdminRepository { void save(UserService service); }
class JpaAdminRepository implements AdminRepository { public void save(UserService service) {} }
class UserServiceChild extends UserService { public void audit() {} }
