pub struct Order {
    pub id: u32,
    status: Status,
}

struct UserId(String);

pub enum Status {
    Pending,
    Paid,
    Failed(String),
}
