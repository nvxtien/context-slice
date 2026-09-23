use crate::repository::OrderRepository;
use crate::repository::postgres::PostgresRepository as Postgres;

pub struct OrderService;

impl OrderService {
    pub fn new() -> Self {
        OrderService
    }
}
